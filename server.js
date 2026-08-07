require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const path = require('path');
const admin = require('firebase-admin');
const axios = require('axios');

// Initialize Firebase Admin with service account
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
admin.initializeApp({
  credential: admin.credential.cert(firebaseConfig),
  databaseURL: `https://${firebaseConfig.project_id}.firebaseio.com`
});

const db = admin.database();
const app = express();
const PORT = process.env.PORT || 3000;

// Telegram Bot
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// Middleware
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api/', limiter);

// Authentication Middleware
const authenticateToken = (req, res, next) => {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'غير مصرح به' });
  }

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    req.user = verified;
    next();
  } catch (error) {
    res.status(403).json({ error: 'جلسة غير صالحة' });
  }
};

// ============ TELEGRAM FUNCTIONS ============
async function sendTelegramMessage(chatId, text, keyboard = null) {
  try {
    const payload = {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML'
    };
    
    if (keyboard) {
      payload.reply_markup = JSON.stringify({
        inline_keyboard: keyboard
      });
    }
    
    const response = await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
    return response.data;
  } catch (error) {
    console.error('Telegram error:', error.response?.data || error.message);
    throw error;
  }
}

// Send notification when medication is taken
async function notifyMedicationTaken(medication, patientName = 'المريض') {
  const message = `
✅ <b>تم تناول الدواء</b>

👤 ${patientName}
💊 ${medication.name}
💉 الجرعة: ${medication.dosage}
🕐 الوقت: ${medication.time}
📅 التاريخ: ${medication.date}

✅ تم التأكيد: ${new Date().toLocaleString('ar')}
  `;
  
  // Send to all patients with chat IDs
  const patientsSnapshot = await db.ref('patients').once('value');
  const patients = patientsSnapshot.val() || {};
  
  for (const [id, patient] of Object.entries(patients)) {
    if (patient.chatId) {
      try {
        await sendTelegramMessage(patient.chatId, message);
        console.log(`✅ Notification sent to ${patient.name || 'patient'}`);
      } catch (error) {
        console.error(`Failed to send to ${patient.name}:`, error);
      }
    }
  }
}

// Send reminder notification
async function sendReminder(medication, patientName = 'المريض') {
  const message = `
🔔 <b>تذكير بتناول الدواء</b>

👤 ${patientName}
💊 ${medication.name}
💉 الجرعة: ${medication.dosage}
🕐 الموعد: ${medication.time}
📅 التاريخ: ${medication.date}

⚠️ يرجى تناول الدواء في الموعد المحدد
  `;
  
  const patientsSnapshot = await db.ref('patients').once('value');
  const patients = patientsSnapshot.val() || {};
  
  for (const [id, patient] of Object.entries(patients)) {
    if (patient.chatId) {
      try {
        await sendTelegramMessage(patient.chatId, message, [
          [
            { text: '✅ تم التناول', callback_data: `taken_${medication.id}` },
            { text: '⏰ تذكير بعد 10 دقائق', callback_data: `remind_later_${medication.id}` }
          ]
        ]);
        console.log(`✅ Reminder sent to ${patient.name || 'patient'}`);
      } catch (error) {
        console.error(`Failed to send reminder to ${patient.name}:`, error);
      }
    }
  }
}

// ============ ROUTES ============

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'الرجاء إدخال اسم المستخدم وكلمة المرور' });
  }

  if (username === process.env.ADMIN_USERNAME && 
      password === process.env.ADMIN_PASSWORD) {
    
    const token = jwt.sign(
      { username, role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000
    });

    return res.json({ 
      success: true, 
      message: 'تم تسجيل الدخول بنجاح',
      token 
    });
  }

  res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
});

// Logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'تم تسجيل الخروج' });
});

// Check auth
app.get('/api/check-auth', (req, res) => {
  const token = req.cookies.token;
  if (!token) {
    return res.json({ authenticated: false });
  }

  try {
    jwt.verify(token, process.env.JWT_SECRET);
    res.json({ authenticated: true });
  } catch (error) {
    res.json({ authenticated: false });
  }
});

// ============ MEDICATION ROUTES ============

// Get all medications (public - for index.html)
app.get('/api/medications', async (req, res) => {
  try {
    const snapshot = await db.ref('medications').once('value');
    const medications = snapshot.val() || {};
    
    const allMeds = Object.entries(medications)
      .map(([id, med]) => ({
        id,
        ...med,
        taken: med.taken || false
      }))
      .sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return (a.time || '00:00').localeCompare(b.time || '00:00');
      });

    res.json(allMeds);
  } catch (error) {
    console.error('Error fetching medications:', error);
    res.status(500).json({ error: 'حدث خطأ في جلب الأدوية' });
  }
});

// Get medications by date (public)
app.post('/api/medications/filter', async (req, res) => {
  const { date } = req.body;
  
  if (!date) {
    return res.status(400).json({ error: 'الرجاء تحديد التاريخ' });
  }

  try {
    const snapshot = await db.ref('medications').once('value');
    const medications = snapshot.val() || {};
    
    const filteredMeds = Object.entries(medications)
      .filter(([id, med]) => {
        const medDate = med.date || med.createdAt?.split('T')[0];
        return medDate === date;
      })
      .map(([id, med]) => ({
        id,
        ...med,
        taken: med.taken || false
      }));

    res.json(filteredMeds);
  } catch (error) {
    console.error('Error filtering medications:', error);
    res.status(500).json({ error: 'حدث خطأ في تصفية الأدوية' });
  }
});

// Add medication (protected)
app.post('/api/medications', authenticateToken, async (req, res) => {
  const { name, dosage, time, date, notes } = req.body;

  if (!name || !dosage || !time || !date) {
    return res.status(400).json({ error: 'الرجاء ملء جميع الحقول المطلوبة' });
  }

  try {
    const newMed = {
      name,
      dosage,
      time,
      date,
      notes: notes || '',
      active: true,
      taken: false,
      createdAt: new Date().toISOString()
    };

    const ref = db.ref('medications').push();
    await ref.set(newMed);

    // Send reminder notification to all patients
    await sendReminder({ id: ref.key, ...newMed });

    res.status(201).json({
      success: true,
      id: ref.key,
      medication: { id: ref.key, ...newMed }
    });
  } catch (error) {
    console.error('Error adding medication:', error);
    res.status(500).json({ error: 'حدث خطأ في إضافة الدواء' });
  }
});

// Mark medication as taken (protected)
app.put('/api/medications/:id/take', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { patientName } = req.body;

  try {
    const medRef = db.ref(`medications/${id}`);
    const snapshot = await medRef.once('value');
    const medication = snapshot.val();

    if (!medication) {
      return res.status(404).json({ error: 'الدواء غير موجود' });
    }

    await medRef.update({
      taken: true,
      takenAt: new Date().toISOString()
    });

    // Send notification to all patients
    await notifyMedicationTaken({ id, ...medication }, patientName || 'المريض');

    res.json({
      success: true,
      message: 'تم تسجيل تناول الدواء وإرسال الإشعار'
    });
  } catch (error) {
    console.error('Error marking medication as taken:', error);
    res.status(500).json({ error: 'حدث خطأ في تحديث حالة الدواء' });
  }
});

// Delete medication (protected)
app.delete('/api/medications/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const medRef = db.ref(`medications/${id}`);
    const snapshot = await medRef.once('value');
    const medication = snapshot.val();

    if (!medication) {
      return res.status(404).json({ error: 'الدواء غير موجود' });
    }

    await medRef.remove();

    res.json({
      success: true,
      message: 'تم حذف الدواء بنجاح'
    });
  } catch (error) {
    console.error('Error deleting medication:', error);
    res.status(500).json({ error: 'حدث خطأ في حذف الدواء' });
  }
});

// ============ PATIENT ROUTES ============

// Get all patients (protected)
app.get('/api/patients', authenticateToken, async (req, res) => {
  try {
    const snapshot = await db.ref('patients').once('value');
    const patients = snapshot.val() || {};
    
    const allPatients = Object.entries(patients).map(([id, patient]) => ({
      id,
      ...patient
    }));

    res.json(allPatients);
  } catch (error) {
    console.error('Error fetching patients:', error);
    res.status(500).json({ error: 'حدث خطأ في جلب المرضى' });
  }
});

// Add patient (protected)
app.post('/api/patients', authenticateToken, async (req, res) => {
  const { name, chatId, notes } = req.body;

  if (!name || !chatId) {
    return res.status(400).json({ error: 'الرجاء إدخال الاسم و Chat ID' });
  }

  try {
    const newPatient = {
      name,
      chatId,
      notes: notes || '',
      createdAt: new Date().toISOString()
    };

    const ref = db.ref('patients').push();
    await ref.set(newPatient);

    // Send welcome message
    try {
      await sendTelegramMessage(chatId, `👋 مرحباً ${name}!\n\nتم تسجيلك في نظام تذكير الأدوية. ستتلقى إشعارات عند مواعيد الأدوية.`);
    } catch (error) {
      console.error('Failed to send welcome message:', error);
    }

    res.status(201).json({
      success: true,
      id: ref.key,
      patient: { id: ref.key, ...newPatient }
    });
  } catch (error) {
    console.error('Error adding patient:', error);
    res.status(500).json({ error: 'حدث خطأ في إضافة المريض' });
  }
});

// Delete patient (protected)
app.delete('/api/patients/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    await db.ref(`patients/${id}`).remove();
    res.json({ success: true, message: 'تم حذف المريض بنجاح' });
  } catch (error) {
    console.error('Error deleting patient:', error);
    res.status(500).json({ error: 'حدث خطأ في حذف المريض' });
  }
});

// Test Telegram (protected)
app.post('/api/telegram/test', authenticateToken, async (req, res) => {
  const { chatId, message } = req.body;

  if (!chatId) {
    return res.status(400).json({ error: 'الرجاء إدخال Chat ID' });
  }

  try {
    await sendTelegramMessage(chatId, message || '🔔 رسالة اختبارية من نظام تذكير الأدوية');
    res.json({ success: true, message: 'تم إرسال رسالة الاختبار بنجاح' });
  } catch (error) {
    console.error('Telegram test error:', error);
    res.status(500).json({ error: 'فشل إرسال رسالة الاختبار' });
  }
});

// ============ TELEGRAM WEBHOOK ROUTES ============

// Set Telegram webhook
app.post('/api/telegram/set-webhook', authenticateToken, async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'الرجاء إدخال URL' });
    }
    
    const response = await axios.post(`${TELEGRAM_API}/setWebhook`, {
      url: url
    });
    
    res.json({
      success: true,
      message: 'تم تعيين Webhook بنجاح',
      data: response.data
    });
  } catch (error) {
    console.error('Set webhook error:', error);
    res.status(500).json({ error: 'فشل في تعيين Webhook' });
  }
});

// Get webhook info
app.get('/api/telegram/webhook-info', authenticateToken, async (req, res) => {
  try {
    const response = await axios.get(`${TELEGRAM_API}/getWebhookInfo`);
    res.json(response.data);
  } catch (error) {
    console.error('Get webhook error:', error);
    res.status(500).json({ error: 'فشل في جلب معلومات Webhook' });
  }
});

// Telegram webhook endpoint (public)
app.post('/api/webhook/telegram', express.json(), async (req, res) => {
  try {
    const { callback_query, message } = req.body;
    
    // Handle callback queries (button clicks)
    if (callback_query) {
      const { data, from, message: callbackMessage } = callback_query;
      const chatId = from.id;
      
      if (data && data.startsWith('taken_')) {
        const medicationId = data.replace('taken_', '');
        
        // Mark medication as taken
        const medRef = db.ref(`medications/${medicationId}`);
        const snapshot = await medRef.once('value');
        const medication = snapshot.val();
        
        if (medication && !medication.taken) {
          await medRef.update({
            taken: true,
            takenAt: new Date().toISOString()
          });
          
          await sendTelegramMessage(chatId, `✅ تم تسجيل تناول ${medication.name}`);
          
          // Notify all patients
          await notifyMedicationTaken({ id: medicationId, ...medication });
        } else if (medication && medication.taken) {
          await sendTelegramMessage(chatId, `ℹ️ ${medication.name} تم تناوله بالفعل`);
        } else {
          await sendTelegramMessage(chatId, `❌ الدواء غير موجود`);
        }
      } else if (data && data.startsWith('remind_later_')) {
        const medicationId = data.replace('remind_later_', '');
        
        // Send reminder after 10 minutes
        setTimeout(async () => {
          const medRef = db.ref(`medications/${medicationId}`);
          const snapshot = await medRef.once('value');
          const medication = snapshot.val();
          
          if (medication && !medication.taken) {
            await sendReminder({ id: medicationId, ...medication });
          }
        }, 10 * 60 * 1000); // 10 minutes
        
        await sendTelegramMessage(chatId, `⏰ سيتم التذكير بعد 10 دقائق`);
      }
      
      // Answer callback query
      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
        callback_query_id: callback_query.id
      });
    }
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error');
  }
});

// ============ SERVE HTML ============

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'حدث خطأ في الخادم' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📋 Admin login:`);
  console.log(`   Username: ${process.env.ADMIN_USERNAME}`);
  console.log(`   Password: ${process.env.ADMIN_PASSWORD}`);
  console.log(`🤖 Telegram Bot Token: ${TELEGRAM_BOT_TOKEN ? '✅ تم تعيينه' : '❌ غير معين'}`);
});
