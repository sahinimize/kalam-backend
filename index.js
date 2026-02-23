require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const server = http.createServer(app);
const io = new Server(server, { 
  cors: { 
    origin: "*", 
    methods: ["GET", "POST"] 
  } 
});

const PORT = process.env.PORT || 3001;

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Database connection established.'))
  .catch(err => console.error('DB Connection Error:', err));

const userSchema = new mongoose.Schema({
  kullaniciAdi: { type: String, required: true, unique: true },
  sifre: { type: String, required: true },
  avatar: { type: String, default: "" },
  arkadaslar: { type: [String], default: [] },
  gelenIstekler: { type: [String], default: [] },
  gidenIstekler: { type: [String], default: [] },
  sunucuDavetleri: { type: Array, default: [] }
});
const Kullanici = mongoose.model('Kullanici', userSchema);

const serverSchema = new mongoose.Schema({
  isim: String, 
  sahip: String, 
  uyeler: [String], 
  roller: [{ isim: String, renk: String }]
});
const Sunucu = mongoose.model('Sunucu', serverSchema);

const channelSchema = new mongoose.Schema({ 
  sunucuId: String, 
  isim: String, 
  tip: { type: String, default: "metin" } 
});
const Kanal = mongoose.model('Kanal', channelSchema);

const messageSchema = new mongoose.Schema({
  kanalId: String, 
  metin: String, 
  gorsel: String, 
  gonderen: String, 
  avatar: String, 
  saat: String, 
  tarih: { type: Date, default: Date.now }
});
const Mesaj = mongoose.model('Mesaj', messageSchema);

const triggerGlobalUpdate = () => io.emit("genelGuncelleme");

// Auth Routes
app.post('/api/kayit', async (req, res) => {
  try {
    const { kullaniciAdi, sifre } = req.body;
    const exists = await Kullanici.findOne({ kullaniciAdi });
    if (exists) return res.status(400).json({ hata: "Bu isim kullanımda." });
    
    const hash = await bcrypt.hash(sifre, 10);
    await new Kullanici({ kullaniciAdi, sifre: hash }).save();
    res.status(201).json({ mesaj: "Kayıt başarılı, giriş yapabilirsiniz." });
  } catch (err) {
    res.status(500).json({ hata: "Sunucu hatası." });
  }
});

app.post('/api/giris', async (req, res) => {
  try {
    const { kullaniciAdi, sifre } = req.body;
    const user = await Kullanici.findOne({ kullaniciAdi });
    if (!user || !(await bcrypt.compare(sifre, user.sifre))) {
      return res.status(400).json({ hata: "Kullanıcı adı veya şifre hatalı." });
    }
    res.status(200).json({ mesaj: "Giriş yapıldı.", avatar: user.avatar });
  } catch (err) {
    res.status(500).json({ hata: "Giriş işlemi başarısız." });
  }
});

// Profile Management
app.post('/api/kullanici-guncelle', async (req, res) => {
  try {
    const { eskiAd, yeniAd, avatar } = req.body;
    const user = await Kullanici.findOne({ kullaniciAdi: eskiAd });
    
    if (yeniAd && yeniAd !== eskiAd) {
      const exists = await Kullanici.findOne({ kullaniciAdi: yeniAd });
      if (exists) return res.status(400).json({ hata: "Bu isim zaten alınmış." });
      
      await Sunucu.updateMany({ sahip: eskiAd }, { $set: { sahip: yeniAd } });
      await Sunucu.updateMany({ uyeler: eskiAd }, { $set: { "uyeler.$": yeniAd } });
      await Mesaj.updateMany({ gonderen: eskiAd }, { $set: { gonderen: yeniAd } });
      await Kullanici.updateMany({ arkadaslar: eskiAd }, { $set: { "arkadaslar.$": yeniAd } });
      await Kullanici.updateMany({ gelenIstekler: eskiAd }, { $set: { "gelenIstekler.$": yeniAd } });
      user.kullaniciAdi = yeniAd;
    }
    
    if (avatar !== undefined) {
      user.avatar = avatar;
      await Mesaj.updateMany({ gonderen: user.kullaniciAdi }, { $set: { avatar: avatar } });
    }
    
    await user.save();
    triggerGlobalUpdate();
    res.json({ mesaj: "Profil güncellendi.", yeniAd: user.kullaniciAdi });
  } catch (err) {
    res.status(500).json({ hata: "Güncelleme başarısız." });
  }
});

app.post('/api/kullanici-sil', async (req, res) => {
  const { kullaniciAdi } = req.body;
  await Kullanici.deleteOne({ kullaniciAdi });
  await Kullanici.updateMany({}, { $pull: { arkadaslar: kullaniciAdi, gelenIstekler: kullaniciAdi } });
  await Sunucu.updateMany({}, { $pull: { uyeler: kullaniciAdi } });
  triggerGlobalUpdate();
  res.json({ mesaj: "Hesap silindi." });
});

app.get('/api/kullanici/:isim', async (req, res) => {
  const user = await Kullanici.findOne({ kullaniciAdi: req.params.isim });
  res.json(user || { arkadaslar: [], gelenIstekler: [], sunucuDavetleri: [], avatar: "" });
});

// Friends & Invites
app.post('/api/istek-gonder', async (req, res) => {
  const { gonderen, alici } = req.body;
  if (gonderen === alici) return res.status(400).json({ hata: "Kendinizi ekleyemezsiniz." });
  
  const targetUser = await Kullanici.findOne({ kullaniciAdi: alici });
  const senderUser = await Kullanici.findOne({ kullaniciAdi: gonderen });
  
  if (!targetUser) return res.status(404).json({ hata: "Kullanıcı bulunamadı." });
  if (senderUser.arkadaslar.includes(alici)) return res.status(400).json({ hata: "Zaten arkadaşsınız." });
  if (targetUser.gelenIstekler.includes(gonderen)) return res.status(400).json({ hata: "İstek zaten gönderilmiş." });
  
  targetUser.gelenIstekler.push(gonderen);
  senderUser.gidenIstekler.push(alici);
  await targetUser.save();
  await senderUser.save();
  triggerGlobalUpdate();
  res.json({ mesaj: "İstek gönderildi." });
});

app.post('/api/istek-onayla', async (req, res) => {
  const { ben, o } = req.body;
  const targetUser = await Kullanici.findOne({ kullaniciAdi: ben });
  const sourceUser = await Kullanici.findOne({ kullaniciAdi: o });
  
  targetUser.gelenIstekler = targetUser.gelenIstekler.filter(i => i !== o);
  sourceUser.gidenIstekler = sourceUser.gidenIstekler.filter(i => i !== ben);
  targetUser.arkadaslar.push(o);
  sourceUser.arkadaslar.push(ben);
  
  await targetUser.save();
  await sourceUser.save();
  triggerGlobalUpdate();
  res.json({ mesaj: "İstek onaylandı." });
});

app.post('/api/arkadas-cikar', async (req, res) => {
  const { ben, o } = req.body;
  const targetUser = await Kullanici.findOne({ kullaniciAdi: ben });
  const sourceUser = await Kullanici.findOne({ kullaniciAdi: o });
  
  targetUser.arkadaslar = targetUser.arkadaslar.filter(a => a !== o);
  sourceUser.arkadaslar = sourceUser.arkadaslar.filter(a => a !== ben);
  
  await targetUser.save();
  await sourceUser.save();
  triggerGlobalUpdate();
  res.json({ mesaj: "Kullanıcı silindi." });
});

app.post('/api/sunucu-davet-gonder', async (req, res) => {
  const { gonderen, alici, sunucuId, sunucuIsmi } = req.body;
  const targetUser = await Kullanici.findOne({ kullaniciAdi: alici });
  
  if(!targetUser) return res.status(404).json({ hata: "Kullanıcı bulunamadı." });
  
  const server = await Sunucu.findById(sunucuId);
  if(server.uyeler.includes(alici)) return res.status(400).json({ hata: "Kullanıcı zaten sunucuda." });
  if(targetUser.sunucuDavetleri.some(d => d.sunucuId === sunucuId)) return res.status(400).json({ hata: "Davet zaten var." });
  
  targetUser.sunucuDavetleri.push({ sunucuId, sunucuIsmi, gonderen });
  await targetUser.save();
  triggerGlobalUpdate();
  res.json({ mesaj: "Davet iletildi." });
});

app.post('/api/sunucu-davet-cevap', async (req, res) => {
  const { kullaniciAdi, sunucuId, kabul } = req.body;
  const user = await Kullanici.findOne({ kullaniciAdi });
  
  user.sunucuDavetleri = user.sunucuDavetleri.filter(d => d.sunucuId !== sunucuId);
  await user.save();
  
  if(kabul) {
    const server = await Sunucu.findById(sunucuId);
    if(server && !server.uyeler.includes(kullaniciAdi)) {
      server.uyeler.push(kullaniciAdi);
      await server.save();
    }
  }
  triggerGlobalUpdate();
  res.json({ mesaj: kabul ? "Sunucuya katıldınız." : "Davet reddedildi." });
});

// Server Management Routes
app.get('/api/sunucular/:isim', async (req, res) => {
  const data = await Sunucu.find({ uyeler: req.params.isim });
  res.json(data);
});

app.post('/api/sunucu-olustur', async (req, res) => {
  const newServer = new Sunucu({ 
    isim: req.body.isim, 
    sahip: req.body.sahip, 
    uyeler: [req.body.sahip], 
    roller: [{ isim: "Admin", renk: "#a855f7" }] 
  });
  await newServer.save();
  await new Kanal({ sunucuId: newServer._id, isim: "genel", tip: "metin" }).save();
  await new Kanal({ sunucuId: newServer._id, isim: "Sohbet", tip: "sesli" }).save();
  triggerGlobalUpdate();
  res.json(newServer);
});

app.get('/api/kanallar/:sunucuId', async (req, res) => {
  const data = await Kanal.find({ sunucuId: req.params.sunucuId });
  res.json(data);
});

app.post('/api/kanal-olustur', async (req, res) => { 
  const channel = await new Kanal({ ...req.body, tip: req.body.tip || "metin" }).save(); 
  triggerGlobalUpdate(); 
  res.json(channel); 
});

app.post('/api/kanal-sil', async (req, res) => {
  await Kanal.findByIdAndDelete(req.body.kanalId); 
  await Mesaj.deleteMany({ kanalId: req.body.kanalId });
  triggerGlobalUpdate(); 
  res.json({ mesaj: "Kanal kaldırıldı." });
});

app.post('/api/kanal-duzenle', async (req, res) => {
  await Kanal.findByIdAndUpdate(req.body.kanalId, { isim: req.body.yeniIsim }); 
  triggerGlobalUpdate(); 
  res.json({ mesaj: "Kanal güncellendi." });
});

app.post('/api/rol-olustur', async (req, res) => {
  const server = await Sunucu.findById(req.body.sunucuId); 
  server.roller.push({ isim: req.body.rolIsmi, renk: req.body.rolRenk });
  await server.save(); 
  triggerGlobalUpdate(); 
  res.json({ mesaj: "Rol oluşturuldu." });
});

// Socket & WebRTC Signaling
const activeUsers = {};
const activeVoiceRooms = {}; 

io.on('connection', (socket) => {
  socket.on('kullaniciGirisYapti', (isim) => { 
    activeUsers[socket.id] = isim; 
    io.emit('aktifKullanicilarGuncellendi', Object.values(activeUsers)); 
  });
  
  socket.on('kanalaKatil', async (kanalId) => {
    Array.from(socket.rooms).forEach(room => { if (room !== socket.id) socket.leave(room); });
    socket.join(kanalId);
    try { 
      const messages = await Mesaj.find({ kanalId: kanalId }).sort({ tarih: 1 }).limit(100);
      socket.emit('eskiMesajlar', messages); 
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('mesajGonder', async (veri) => { 
    await new Mesaj(veri).save(); 
    io.to(veri.kanalId).emit('mesajGeldi', veri); 
  });
  
  socket.on("sesliKanalaKatil", ({ kanalId, kullaniciAdi }) => {
    const roomName = `voice_${kanalId}`;
    socket.join(roomName);
    socket.to(roomName).emit("kullaniciSesliyeKatildi", { socketId: socket.id, kullaniciAdi });
    
    if(!activeVoiceRooms[kanalId]) activeVoiceRooms[kanalId] = [];
    activeVoiceRooms[kanalId].push({ id: socket.id, isim: kullaniciAdi });
    io.in(roomName).emit("sesliKanalUyeleriGuncellendi", activeVoiceRooms[kanalId]);
  });

  socket.on("webrtc-teklif", (data) => { 
    io.to(data.hedef).emit("webrtc-teklif", { sdp: data.sdp, gonderen: socket.id, kullaniciAdi: data.kullaniciAdi }); 
  });
  
  socket.on("webrtc-cevap", (data) => { 
    io.to(data.hedef).emit("webrtc-cevap", { sdp: data.sdp, gonderen: socket.id }); 
  });
  
  socket.on("webrtc-ice-adayi", (data) => { 
    io.to(data.hedef).emit("webrtc-ice-adayi", { aday: data.aday, gonderen: socket.id }); 
  });

  socket.on("sesliKanaldanAyril", (kanalId) => {
    const roomName = `voice_${kanalId}`;
    socket.leave(roomName);
    socket.to(roomName).emit("kullaniciSeslidenAyrildi", socket.id);
    
    if(activeVoiceRooms[kanalId]) {
      activeVoiceRooms[kanalId] = activeVoiceRooms[kanalId].filter(u => u.id !== socket.id);
      io.in(roomName).emit("sesliKanalUyeleriGuncellendi", activeVoiceRooms[kanalId]);
    }
  });

  socket.on('disconnect', () => { 
    if (activeUsers[socket.id]) { 
      delete activeUsers[socket.id]; 
      io.emit('aktifKullanicilarGuncellendi', Object.values(activeUsers)); 
    }
    
    for (const kanalId in activeVoiceRooms) {
      const index = activeVoiceRooms[kanalId].findIndex(u => u.id === socket.id);
      if (index !== -1) {
        activeVoiceRooms[kanalId].splice(index, 1);
        socket.to(`voice_${kanalId}`).emit("kullaniciSeslidenAyrildi", socket.id);
        io.in(`voice_${kanalId}`).emit("sesliKanalUyeleriGuncellendi", activeVoiceRooms[kanalId]);
      }
    }
  });
});

server.listen(PORT, () => console.log(`Service running on port ${PORT}`));