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

// ============ FIREBASE SETUP ============
console.log('🔧 Initializing Firebase...');

let firebaseConfig;
try {
  firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  console.log('✅ Firebase config parsed successfully');
} catch (error) {
  console.error('❌ Failed to parse FIREBASE_CONFIG:', error.message);
  console.error('Please check your .env file');
  process.exit(1);
}

// Initialize Firebase
try {
  admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig),
    databaseURL: `https://${firebaseConfig.project_id}.firebaseio.com`
  });
  console.log('✅ Firebase initialized successfully');
  console.log(`📁 Project ID: ${firebaseConfig.project_id}`);
} catch (error) {
  console.error('❌ Failed to initialize Firebase:', error.message);
  process.exit(1);
}

const db = admin.database();
const app = express();
const PORT = process.env.PORT || 3000;

// ============ TELEGRAM SETUP ============
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

console.log(`🤖 Telegram Bot: ${TELEGRAM_BOT_TOKEN ? '✅ Configured' : '❌ Missing'}`);

// ============ MIDDLEWARE ============
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

// ============ AUTH MIDDLEWARE ============
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
  
  try {
    const snapshot = await db.ref('patients').once('value');
    const patients = snapshot.val() || {};
    
    for (const [id, patient] of Object.entries(patients)) {
      if (patient.chatId) {
        try {
          await sendTelegramMessage(patient.chatId, message);
        } catch (err) {
          console.error(`Failed to send to ${patient.name}:`, err);
        }
      }
    }
  } catch (error) {
    console.error('Error getting patients:', error);
  }
}

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
  
  try {
    const snapshot = await db.ref('patients').once('value');
    const patients = snapshot.val() || {};
    
    for (const [id, patient] of Object.entries(patients)) {
      if (patient.chatId) {
        try {
          await sendTelegramMessage(patient.chatId, message, [
            [
              { text: '✅ تم التناول', callback_data: `taken_${medication.id}` },
              { text: '⏰ تذكير بعد 10 دقائق', callback_data: `remind_later_${medication.id}` }
            ]
          ]);
        } catch (err) {
          console.error(`Failed to send reminder to ${patient.name}:`, err);
        }
      }
    }
  } catch (error) {
    console.error('Error getting patients:', error);
  }
}

// ============ TEST ROUTE ============
// Test Firebase connection
app.get('/api/test-firebase', async (req, res) => {
  console.log('🔍 Testing Firebase connection...');
  try {
    const testRef = db.ref('test_connection');
    await testRef.set({ 
      timestamp: new Date().toISOString(),
      status: 'connected'
    });
    
    const snapshot = await testRef.once('value');
    console.log('✅ Firebase test successful');
    
    res.json({ 
      success: true, 
      message: 'Firebase is connected!',
      data: snapshot.val()
    });
  } catch (error) {
    console.error('❌ Firebase test failed:', error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      stack: error.stack
    });
  }
});

// ============ AUTH ROUTES ============
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

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'تم تسجيل الخروج' });
});

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
app.get('/api/medications', async (req, res) => {
  console.log('📊 Fetching medications...');
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

    console.log(`✅ Found ${allMeds.length} medications`);
    res.json(allMeds);
  } catch (error) {
    console.error('❌ Error fetching medications:', error.message);
    res.status(500).json({ 
      error: 'حدث خطأ في جلب الأدوية',
      details: error.message
    });
  }
});

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

app.post('/api/medications', authenticateToken, async (req, res) => {
  const { name, dosage, time, date, notes } = req.body;

  if (!name || !dosage || !time || !date) {
    return res.status(400).json({ error: 'الرجاء ملء جميع الحقول المطلوبة' });
  }

  try {
    console.log(`➕ Adding medication: ${name}`);
    
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

    const medicationWithId = { id: ref.key, ...newMed };

    // Send reminder (don't wait for it)
    sendReminder(medicationWithId).catch(err => {
      console.error('Error sending reminder:', err);
    });

    console.log(`✅ Medication added: ${ref.key}`);
    res.status(201).json({
      success: true,
      id: ref.key,
      medication: medicationWithId,
      message: 'تم إضافة الدواء وإرسال التذكير'
    });
  } catch (error) {
    console.error('❌ Error adding medication:', error.message);
    res.status(500).json({ 
      error: 'حدث خطأ في إضافة الدواء',
      details: error.message
    });
  }
});

app.put('/api/medications/:id/take', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { patientName } = req.body;

  try {
    console.log(`✅ Marking medication as taken: ${id}`);
    
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

    // Send notification (don't wait for it)
    notifyMedicationTaken({ id, ...medication }, patientName || 'المريض').catch(err => {
      console.error('Error sending notification:', err);
    });

    console.log(`✅ Medication marked as taken: ${id}`);
    res.json({
      success: true,
      message: 'تم تسجيل تناول الدواء وإرسال الإشعار'
    });
  } catch (error) {
    console.error('❌ Error marking medication as taken:', error.message);
    res.status(500).json({ 
      error: 'حدث خطأ في تحديث حالة الدواء',
      details: error.message
    });
  }
});

app.delete('/api/medications/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    console.log(`🗑️ Deleting medication: ${id}`);
    
    const medRef = db.ref(`medications/${id}`);
    const snapshot = await medRef.once('value');
    const medication = snapshot.val();

    if (!medication) {
      return res.status(404).json({ error: 'الدواء غير موجود' });
    }

    await medRef.remove();

    console.log(`✅ Medication deleted: ${id}`);
    res.json({
      success: true,
      message: 'تم حذف الدواء بنجاح'
    });
  } catch (error) {
    console.error('❌ Error deleting medication:', error.message);
    res.status(500).json({ 
      error: 'حدث خطأ في حذف الدواء',
      details: error.message
    });
  }
});

// ============ PATIENT ROUTES ============
app.get('/api/patients', authenticateToken, async (req, res) => {
  try {
    console.log('👤 Fetching patients...');
    const snapshot = await db.ref('patients').once('value');
    const patients = snapshot.val() || {};
    
    const allPatients = Object.entries(patients).map(([id, patient]) => ({
      id,
      ...patient
    }));

    console.log(`✅ Found ${allPatients.length} patients`);
    res.json(allPatients);
  } catch (error) {
    console.error('❌ Error fetching patients:', error.message);
    res.status(500).json({ 
      error: 'حدث خطأ في جلب المرضى',
      details: error.message
    });
  }
});

app.post('/api/patients', authenticateToken, async (req, res) => {
  const { name, chatId, notes } = req.body;

  if (!name || !chatId) {
    return res.status(400).json({ error: 'الرجاء إدخال الاسم و Chat ID' });
  }

  try {
    console.log(`👤 Adding patient: ${name} (${chatId})`);
    
    const newPatient = {
      name,
      chatId,
      notes: notes || '',
      createdAt: new Date().toISOString()
    };

    const ref = db.ref('patients').push();
    await ref.set(newPatient);

    // Send welcome message (don't wait for it)
    sendTelegramMessage(chatId, `👋 مرحباً ${name}!\n\nتم تسجيلك في نظام تذكير الأدوية. ستتلقى إشعارات عند مواعيد الأدوية.`)
      .then(() => console.log(`✅ Welcome message sent to ${name}`))
      .catch(err => console.error(`Failed to send welcome to ${name}:`, err));

    console.log(`✅ Patient added: ${ref.key}`);
    res.status(201).json({
      success: true,
      id: ref.key,
      patient: { id: ref.key, ...newPatient },
      message: 'تم إضافة المريض وإرسال رسالة الترحيب'
    });
  } catch (error) {
    console.error('❌ Error adding patient:', error.message);
    res.status(500).json({ 
      error: 'حدث خطأ في إضافة المريض',
      details: error.message
    });
  }
});

app.delete('/api/patients/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    console.log(`🗑️ Deleting patient: ${id}`);
    await db.ref(`patients/${id}`).remove();
    console.log(`✅ Patient deleted: ${id}`);
    res.json({ success: true, message: 'تم حذف المريض بنجاح' });
  } catch (error) {
    console.error('❌ Error deleting patient:', error.message);
    res.status(500).json({ 
      error: 'حدث خطأ في حذف المريض',
      details: error.message
    });
  }
});

// ============ TELEGRAM ROUTES ============
app.post('/api/telegram/test', authenticateToken, async (req, res) => {
  const { chatId, message } = req.body;

  if (!chatId) {
    return res.status(400).json({ error: 'الرجاء إدخال Chat ID' });
  }

  try {
    console.log(`📨 Testing Telegram: ${chatId}`);
    await sendTelegramMessage(chatId, message || '🔔 رسالة اختبارية من نظام تذكير الأدوية');
    console.log(`✅ Test message sent to ${chatId}`);
    res.json({ success: true, message: 'تم إرسال رسالة الاختبار بنجاح' });
  } catch (error) {
    console.error('❌ Telegram test error:', error.message);
    res.status(500).json({ 
      error: 'فشل إرسال رسالة الاختبار',
      details: error.message
    });
  }
});

app.post('/api/telegram/set-webhook', authenticateToken, async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'الرجاء إدخال URL' });
    }
    
    console.log(`🔗 Setting webhook: ${url}`);
    const response = await axios.post(`${TELEGRAM_API}/setWebhook`, {
      url: url
    });
    
    console.log(`✅ Webhook set: ${response.data.ok}`);
    res.json({
      success: true,
      message: 'تم تعيين Webhook بنجاح',
      data: response.data
    });
  } catch (error) {
    console.error('❌ Set webhook error:', error.message);
    res.status(500).json({ 
      error: 'فشل في تعيين Webhook',
      details: error.message
    });
  }
});

app.get('/api/telegram/webhook-info', authenticateToken, async (req, res) => {
  try {
    console.log('📡 Getting webhook info...');
    const response = await axios.get(`${TELEGRAM_API}/getWebhookInfo`);
    console.log(`✅ Webhook info: ${response.data.result?.url || 'Not set'}`);
    res.json(response.data);
  } catch (error) {
    console.error('❌ Get webhook error:', error.message);
    res.status(500).json({ 
      error: 'فشل في جلب معلومات Webhook',
      details: error.message
    });
  }
});

// ============ TELEGRAM WEBHOOK ============
app.post('/api/webhook/telegram', express.json(), async (req, res) => {
  try {
    const { callback_query } = req.body;
    
    if (callback_query) {
      const { data, from } = callback_query;
      const chatId = from.id;
      
      if (data && data.startsWith('taken_')) {
        const medicationId = data.replace('taken_', '');
        
        const medRef = db.ref(`medications/${medicationId}`);
        const snapshot = await medRef.once('value');
        const medication = snapshot.val();
        
        if (medication && !medication.taken) {
          await medRef.update({
            taken: true,
            takenAt: new Date().toISOString()
          });
          
          await sendTelegramMessage(chatId, `✅ تم تسجيل تناول ${medication.name}`);
          await notifyMedicationTaken({ id: medicationId, ...medication });
        } else if (medication && medication.taken) {
          await sendTelegramMessage(chatId, `ℹ️ ${medication.name} تم تناوله بالفعل`);
        } else {
          await sendTelegramMessage(chatId, `❌ الدواء غير موجود`);
        }
      } else if (data && data.startsWith('remind_later_')) {
        const medicationId = data.replace('remind_later_', '');
        await sendTelegramMessage(chatId, `⏰ سيتم التذكير بعد 10 دقائق`);
        
        setTimeout(async () => {
          const medRef = db.ref(`medications/${medicationId}`);
          const snapshot = await medRef.once('value');
          const medication = snapshot.val();
          
          if (medication && !medication.taken) {
            await sendReminder({ id: medicationId, ...medication });
          }
        }, 10 * 60 * 1000);
      }
      
      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
        callback_query_id: callback_query.id
      });
    }
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ Webhook error:', error.message);
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

// ============ ERROR HANDLING ============
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.stack);
  res.status(500).json({ 
    error: 'حدث خطأ في الخادم',
    details: err.message
  });
});

// ============ START SERVER ============
app.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📋 Admin login:`);
  console.log(`   Username: ${process.env.ADMIN_USERNAME}`);
  console.log(`   Password: ${process.env.ADMIN_PASSWORD}`);
  console.log(`🤖 Telegram Bot: ${TELEGRAM_BOT_TOKEN ? '✅ Configured' : '❌ Missing'}`);
  console.log('='.repeat(50));
});
