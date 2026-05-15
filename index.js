const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Inisialisasi Gemini dengan API Key Anda
const genAI = new GoogleGenerativeAI('AIzaSyBu5FqPZoYbxi6m08wtup0vsWebOXHXfbE');
const aiModel = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });

// ==========================================
// PENGATURAN KONTAK 
// ==========================================
const NOMOR_PACAR = '6285265243849@s.whatsapp.net'; 
const NOMOR_SAYA = '6283167056686@s.whatsapp.net'; 

// ==========================================
// STATE MANAGEMENT (STATUS, MEMORI & TIMER)
// ==========================================
let statusSaya = 'ngoding'; // Default saat pertama dijalankan
let memoriPercakapan = {}; 

// Sistem Antrean dan Delay Waktu (5m, 15m, 30m, 60m)
const URUTAN_WAKTU = [5 * 60000, 15 * 60000, 30 * 60000, 60 * 60000]; 
let antreanPesan = {}; 

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }) 
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('Membentuk file gambar QR Code...');
            qrcode.toFile('./qr.png', qr, { width: 300 }, function (err) {
                if (err) console.error('Gagal membuat QR:', err);
                console.log('✅ Buka file "qr.png" dan scan!');
            });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== 401;
            console.log('Koneksi terputus. Mencoba menghubungkan kembali...', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ Asisten AI berhasil terhubung dan siap digunakan!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            const msg = messages[0];
            if (!msg.message) return;

            const sender = msg.key.remoteJid;
            const fromMe = msg.key.fromMe;

            // --- FILTER PRIVATE CHAT SAJA ---
            if (!sender || sender.endsWith('@g.us') || sender === 'status@broadcast') {
                return; 
            }

            // 2. EKSTRAKSI TEKS PESAN
            let textMessage = '';
            if (msg.message.conversation) {
                textMessage = msg.message.conversation; 
            } else if (msg.message.extendedTextMessage) {
                textMessage = msg.message.extendedTextMessage.text; 
            } else if (msg.message.ephemeralMessage) {
                const ephMessage = msg.message.ephemeralMessage.message;
                textMessage = ephMessage.conversation || ephMessage.extendedTextMessage?.text;
            }

            if (!textMessage) return;

            console.log(`📩 Pesan Pribadi [Dari Saya: ${fromMe}]: ${textMessage}`);

            // ==========================================
            // 3. FITUR REMOTE CONTROL & AUTO-INTERRUPT
            // ==========================================
            if (fromMe || sender === NOMOR_SAYA) {
                const command = textMessage.toLowerCase();
                
                if (command === '!tidur') {
                    statusSaya = 'tidur';
                    await sock.sendMessage(sender, { text: '⚙️ Status Asisten: Mode Tidur' });
                    return;
                } else if (command === '!ngoding') {
                    statusSaya = 'ngoding';
                    await sock.sendMessage(sender, { text: '⚙️ Status Asisten: Mode Ngoding' });
                    return;
                } else if (command === '!aktif') {
                    statusSaya = 'aktif';
                    await sock.sendMessage(sender, { text: '⚙️ Status Asisten: Mode Aktif' });
                    return;
                } else if (command === '!mati') {
                    statusSaya = 'mati';
                    await sock.sendMessage(sender, { text: '⚙️ Status Asisten: MATI (Hemat Kuota)' });
                    return;
                } else if (command === '!reset') {
                    memoriPercakapan = {};
                    antreanPesan = {};
                    await sock.sendMessage(sender, { text: '⚙️ Memori & Timer dibersihkan.' });
                    return;
                }
                
                // JIKA JATI MEMBALAS MANUAL
                if (fromMe && !textMessage.startsWith('!')) {
                    if (antreanPesan[sender] && antreanPesan[sender].timer) {
                        clearTimeout(antreanPesan[sender].timer);
                    }
                    if (antreanPesan[sender]) {
                        antreanPesan[sender].stepWaktu = 0;
                        antreanPesan[sender].kumpulanTeks = [];
                        antreanPesan[sender].timer = null;
                        antreanPesan[sender].jumlahBalasan = 0; // RESET LIMIT BALASAN
                    }
                    if (statusSaya === 'ngoding') {
                        statusSaya = 'mati';
                        console.log('📱 Membalas manual. Bot otomatis dimatikan.');
                    }
                    return; 
                }
            }

            // ==========================================
            // FILTER STATUS GLOBAL
            // ==========================================
            if (statusSaya === 'mati') return; 

            if (statusSaya === 'tidur') {
                if (!memoriPercakapan[sender]) {
                    await sock.sendMessage(sender, { text: "*(Balasan Otomatis)* Saya sedang tidur. Tolong telpon jika memang sangat darurat." });
                    memoriPercakapan[sender] = true;
                }
                return; 
            }

            // ==========================================
            // LOGIKA ANTREAN TIMER & LIMIT RESPON AI
            // ==========================================
            
            if (!antreanPesan[sender]) {
                antreanPesan[sender] = {
                    stepWaktu: 0, 
                    kumpulanTeks: [], 
                    timer: null,
                    jumlahBalasan: 0 // PELACAK JUMLAH BALASAN AI
                };
            }

            // FILTER LIMIT: Jika bukan pacar dan sudah dibalas 3x, abaikan chat
            if (sender !== NOMOR_PACAR && antreanPesan[sender].jumlahBalasan >= 3) {
                console.log(`🛑 Batas 3 balasan tercapai untuk ${sender}. AI mengabaikan pesan.`);
                return;
            }

            // Tampung pesan yang masuk
            antreanPesan[sender].kumpulanTeks.push(textMessage);
            
            // Jika belum ada timer berjalan, mulai hitungan mundur
            if (!antreanPesan[sender].timer) {
                const batasIndeks = Math.min(antreanPesan[sender].stepWaktu, URUTAN_WAKTU.length - 1);
                const waktuTungguMs = URUTAN_WAKTU[batasIndeks];
                const menitTunggu = waktuTungguMs / 60000;

                console.log(`⏱️ Menunggu ${menitTunggu} menit sebelum merespons ${sender}...`);

                antreanPesan[sender].timer = setTimeout(async () => {
                    // Waktu Habis! AI Akan Memproses Gabungan Pesan
                    const pesanGabungan = antreanPesan[sender].kumpulanTeks.join('\n');
                    
                    // Reset status antrean
                    antreanPesan[sender].kumpulanTeks = [];
                    antreanPesan[sender].timer = null;

                    // Mulai Logika AI
                    if (!memoriPercakapan[sender]) memoriPercakapan[sender] = [];

                    let instruksiAI = "";
                    let pesanSistem = "";
                    const balasanKe = antreanPesan[sender].jumlahBalasan + 1; // Mendeteksi ini balasan ke-berapa

                    // KONDISI UNTUK PACAR (Tanpa Limit)
                    if (sender === NOMOR_PACAR) {
                        instruksiAI = "Kamu adalah asisten virtual pacarku. Balas dengan sangat manis, perhatian, sedikit manja, dan gunakan emoji yang lucu. Jangan kaku sama sekali, bersikaplah seperti pasangan yang menyayangi.";
                        pesanSistem = `[INFO SISTEM: Jati tidak membalas chat ini selama ${menitTunggu} menit. Jawab pesannya dengan natural sesuai personamu.]\n\n`;
                    } 
                    // KONDISI UNTUK ORANG LAIN (Maksimal 3 Limit)
                    else {
                        instruksiAI = "Kamu adalah asisten virtual Jati. Jati adalah seorang Fullstack Developer. Jawablah pesan dari orang ini dengan sopan, ramah, dan ringkas. Sesuaikan obrolan dengan konteks IT jika relevan.";
                        
                        if (balasanKe === 3 && statusSaya === 'ngoding') {
                            // INJEKSI PROMPT FINAL KHUSUS BALASAN KE-3
                            pesanSistem = `[INFO SISTEM PENTING: Ini adalah batas maksimal balasan asisten (ke-3). Beritahu pengirim dengan sopan namun TERTULIS SANGAT JELAS bahwa Jati saat ini sedang fokus tingkat tinggi ngoding sistem dan asisten ini tidak akan membalas pesan lagi setelah ini. Instruksikan pengirim secara langsung untuk LANGSUNG MENELEPON via WhatsApp atau seluler jika memang ada keperluan yang sangat mendesak/darurat.]\n\n`;
                        } else if (balasanKe === 1) {
                            pesanSistem = `[INFO SISTEM: Ini pesan pertama. Beritahu pengirim bahwa Jati tidak membalas selama ${menitTunggu} menit karena sedang fokus ngoding. Setelah memberitahu, baru jawab pesannya dengan natural.]\n\n`;
                        } else {
                            pesanSistem = `[INFO SISTEM: Lanjutkan obrolan. Ingat bahwa Jati sedang ngoding dan belum membalas selama ${menitTunggu} menit. Jangan ulangi alasan ngoding terus-menerus.]\n\n`;
                        }
                    }

                    try {
                        await sock.sendPresenceUpdate('composing', sender);

                        memoriPercakapan[sender].push({ role: "user", parts: [{ text: pesanGabungan }] });

                        const chat = aiModel.startChat({
                            history: [
                                { role: "user", parts: [{ text: instruksiAI }] },
                                { role: "model", parts: [{ text: "Baik, saya mengerti peran dan instruksi saya." }] },
                                ...memoriPercakapan[sender].slice(0, -1) 
                            ],
                        });

                        const promptAkhir = pesanSistem + pesanGabungan;
                        const result = await chat.sendMessage(promptAkhir);
                        const balasanAI = result.response.text();

                        memoriPercakapan[sender].push({ role: "model", parts: [{ text: balasanAI }] });

                        if (memoriPercakapan[sender].length > 12) {
                            memoriPercakapan[sender].splice(0, 2); 
                        }

                        await sock.sendMessage(sender, { text: balasanAI });
                        console.log(`🤖 [Membalas setelah ${menitTunggu} menit | Balasan ke-${balasanKe}] -> ${balasanAI}\n`);

                        // Tambah hitungan balasan & naikkan durasi tunggu
                        antreanPesan[sender].jumlahBalasan++;
                        antreanPesan[sender].stepWaktu++;

                    } catch (error) {
                        console.error("⚠️ Gagal menghubungi AI Gemini:", error);
                    }
                }, waktuTungguMs);
            }
        }
    });
}

connectToWhatsApp();