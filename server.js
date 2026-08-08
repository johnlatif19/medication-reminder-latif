require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const path = require('path');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ FIREBASE SETUP ============
console.log('🔧 Initializing Firebase...');

let firebaseConfig;
try {
  firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  console.log('✅ Firebase config parsed');
} catch (error) {
  console.error('❌ Failed to parse FIREBASE_CONFIG:', error.message);
  process.exit(1);
}

const FIREBASE_DATABASE_URL = firebaseConfig.databaseURL || `https://${firebaseConfig.project_id}.firebaseio.com`;
console.log(`📁 Firebase Database URL: ${FIREBASE_DATABASE_URL}`);

// ============ TELEGRAM SETUP ============
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const APP_URL = 'https://medication-reminder-latif.vercel.app';

// ============ MIDDLEWARE ============
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api/', limiter);

// ============ AUTH MIDDLEWARE ============
const authenticateToken = (req, res, next) => {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'غير مصرح به' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (error) {
    res.status(403).json({ error: 'جلسة غير صالحة' });
  }
};

// ============ HELPER FUNCTIONS ============
async function firebaseGet(path) {
  try {
    const url = `${FIREBASE_DATABASE_URL}/${path}.json`;
    const response = await axios.get(url);
    return response.data || {};
  } catch (error) {
    console.error(`❌ Firebase GET error (${path}):`, error.message);
    throw error;
  }
}

async function firebasePost(path, data) {
  try {
    const url = `${FIREBASE_DATABASE_URL}/${path}.json`;
    const response = await axios.post(url, data);
    return response.data;
  } catch (error) {
    console.error(`❌ Firebase POST error (${path}):`, error.message);
    throw error;
  }
}

async function firebasePut(path, data) {
  try {
    const url = `${FIREBASE_DATABASE_URL}/${path}.json`;
    const response = await axios.put(url, data);
    return response.data;
  } catch (error) {
    console.error(`❌ Firebase PUT error (${path}):`, error.message);
    throw error;
  }
}

async function firebaseDelete(path) {
  try {
    const url = `${FIREBASE_DATABASE_URL}/${path}.json`;
    const response = await axios.delete(url);
    return response.data;
  } catch (error) {
    console.error(`❌ Firebase DELETE error (${path}):`, error.message);
    throw error;
  }
}

// ============ TELEGRAM FUNCTIONS ============
async function sendTelegramMessage(chatId, text, keyboard = null) {
  try {
    const payload = {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML'
    };
    if (keyboard) {
      payload.reply_markup = JSON.stringify({ inline_keyboard: keyboard });
    }
    const response = await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
    return response.data;
  } catch (error) {
    console.error('Telegram error:', error.message);
    throw error;
  }
}

// Send welcome message to new patient
async function sendWelcomeMessage(chatId, patientName) {
  const message = `👋 مرحباً ${patientName}!

تم تسجيلك في نظام تذكير الأدوية. ستتلقى إشعارات عند مواعيد الأدوية.

لمتابعة الأدوية: ${APP_URL}`;
  
  await sendTelegramMessage(chatId, message);
}

// Send test message
async function sendTestMessage(chatId) {
  const message = `🔔 هذه رسالة اختبارية من نظام تذكير الأدوية

لمتابعة الأدوية: ${APP_URL}`;
  
  await sendTelegramMessage(chatId, message);
}

// Send daily summary
async function sendDailySummary(chatId, date) {
  const message = `📋 يوم ${date} خلص

نبدأ أدوية من بكرة بإذن الله

لمتابعة الأدوية: ${APP_URL}`;
  
  await sendTelegramMessage(chatId, message);
}

// Send medication reminder
async function sendMedicationReminder(medication, patientName = 'المريض') {
  const message = `🔔 تذكير بتناول الدواء

👤 ${patientName}
💊 ${medication.name}
💉 الجرعة: ${medication.dosage}
🕐 الموعد: ${medication.time}
📅 التاريخ: ${medication.date}

يرجى تناول الدواء في الموعد المحدد

لمتابعة الأدوية: ${APP_URL}`;
  
  const patients = await firebaseGet('patients');
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
}

// Send medication taken notification
async function notifyMedicationTaken(medication, patientName = 'المريض') {
  const message = `✅ تم تناول الدواء

👤 ${patientName}
💊 ${medication.name}
💉 الجرعة: ${medication.dosage}
🕐 الوقت: ${medication.time}
📅 التاريخ: ${medication.date}

✅ تم التأكيد: ${new Date().toLocaleString('ar')}

لمتابعة الأدوية: ${APP_URL}`;
  
  const patients = await firebaseGet('patients');
  for (const [id, patient] of Object.entries(patients)) {
    if (patient.chatId) {
      try {
        await sendTelegramMessage(patient.chatId, message);
      } catch (err) {
        console.error(`Failed to send to ${patient.name}:`, err);
      }
    }
  }
}

// ============ CRON JOB FOR DAILY REMINDERS ============
// Check every minute for medications that need reminders
cron.schedule('* * * * *', async () => {
  try {
    console.log('⏰ Running scheduler...');
    const now = new Date();
    const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    const currentDate = now.toISOString().split('T')[0];
    
    const medications = await firebaseGet('medications');
    
    for (const [id, med] of Object.entries(medications)) {
      // Check if medication is active, not taken, and matches current time and date
      if (med.active && !med.taken && med.time === currentTime && med.date === currentDate) {
        // Check if reminder already sent for this medication today
        const reminderKey = `reminder_${id}_${currentDate}`;
        const reminderSent = await firebaseGet(`reminders/${reminderKey}`);
        
        if (!reminderSent) {
          console.log(`🔔 Sending reminder for: ${med.name} at ${currentTime}`);
          await sendMedicationReminder({ id, ...med });
          // Mark reminder as sent
          await firebasePut(`reminders/${reminderKey}`, { 
            sent: true, 
            timestamp: new Date().toISOString() 
          });
        }
      }
    }
  } catch (error) {
    console.error('❌ Scheduler error:', error.message);
  }
});

// ============ TEST ROUTE ============
app.get('/api/test-firebase', async (req, res) => {
  console.log('🔍 Testing Firebase connection...');
  try {
    const testData = { 
      timestamp: new Date().toISOString(), 
      status: 'connected',
      test: 'Hello from Vercel!'
    };
    
    await firebasePut('test_connection', testData);
    const data = await firebaseGet('test_connection');
    
    res.json({ 
      success: true, 
      message: 'Firebase is connected!',
      databaseURL: FIREBASE_DATABASE_URL,
      data: data
    });
  } catch (error) {
    console.error('❌ Firebase test failed:', error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      databaseURL: FIREBASE_DATABASE_URL
    });
  }
});

// ============ AUTH ROUTES ============
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'الرجاء إدخال اسم المستخدم وكلمة المرور' });
  }

  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ username, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000
    });
    return res.json({ success: true, message: 'تم تسجيل الدخول بنجاح', token });
  }
  res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'تم تسجيل الخروج' });
});

app.get('/api/check-auth', (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.json({ authenticated: false });
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
    const medications = await firebaseGet('medications');
    const allMeds = Object.entries(medications)
      .map(([id, med]) => ({ id, ...med, taken: med.taken || false }))
      .sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return (a.time || '00:00').localeCompare(b.time || '00:00');
      });
    console.log(`✅ Found ${allMeds.length} medications`);
    res.json(allMeds);
  } catch (error) {
    console.error('❌ Error fetching medications:', error.message);
    res.status(500).json({ error: 'حدث خطأ في جلب الأدوية', details: error.message });
  }
});

app.post('/api/medications/filter', async (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'الرجاء تحديد التاريخ' });

  try {
    console.log(`🔍 Filtering medications for date: ${date}`);
    const medications = await firebaseGet('medications');
    const today = new Date().toISOString().split('T')[0];
    
    // Get filtered medications
    const filteredMeds = Object.entries(medications)
      .filter(([id, med]) => {
        const medDate = med.date || med.createdAt?.split('T')[0];
        return medDate === date;
      })
      .map(([id, med]) => ({ id, ...med, taken: med.taken || false }));
    
    // If filtering for today, send daily summary to all patients
    if (date === today) {
      const patients = await firebaseGet('patients');
      for (const [id, patient] of Object.entries(patients)) {
        if (patient.chatId) {
          try {
            await sendDailySummary(patient.chatId, date);
          } catch (err) {
            console.error(`Failed to send summary to ${patient.name}:`, err);
          }
        }
      }
    }
    
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
      name, dosage, time, date,
      notes: notes || '',
      active: true,
      taken: false,
      createdAt: new Date().toISOString()
    };

    const result = await firebasePost('medications', newMed);
    const medicationWithId = { id: result.name, ...newMed };

    // Send reminder immediately
    await sendMedicationReminder(medicationWithId);

    console.log(`✅ Medication added: ${result.name}`);
    res.status(201).json({
      success: true,
      id: result.name,
      medication: medicationWithId,
      message: 'تم إضافة الدواء وإرسال التذكير'
    });
  } catch (error) {
    console.error('❌ Error adding medication:', error.message);
    res.status(500).json({ error: 'حدث خطأ في إضافة الدواء', details: error.message });
  }
});

app.put('/api/medications/:id/take', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { patientName } = req.body;

  try {
    console.log(`✅ Marking medication as taken: ${id}`);
    const medication = await firebaseGet(`medications/${id}`);
    if (!medication) return res.status(404).json({ error: 'الدواء غير موجود' });

    await firebasePut(`medications/${id}`, { 
      ...medication, 
      taken: true, 
      takenAt: new Date().toISOString() 
    });

    await notifyMedicationTaken({ id, ...medication }, patientName || 'المريض');

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
    await firebaseDelete(`medications/${id}`);
    console.log(`✅ Medication deleted: ${id}`);
    res.json({ success: true, message: 'تم حذف الدواء بنجاح' });
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
    const patients = await firebaseGet('patients');
    const allPatients = Object.entries(patients).map(([id, patient]) => ({ id, ...patient }));
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
    const result = await firebasePost('patients', newPatient);

    // Send welcome message
    await sendWelcomeMessage(chatId, name);

    console.log(`✅ Patient added: ${result.name}`);
    res.status(201).json({
      success: true,
      id: result.name,
      patient: { id: result.name, ...newPatient },
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
    await firebaseDelete(`patients/${id}`);
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
  if (!chatId) return res.status(400).json({ error: 'الرجاء إدخال Chat ID' });

  try {
    console.log(`📨 Testing Telegram: ${chatId}`);
    await sendTestMessage(chatId);
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
    if (!url) return res.status(400).json({ error: 'الرجاء إدخال URL' });

    console.log(`🔗 Setting webhook: ${url}`);
    const response = await axios.post(`${TELEGRAM_API}/setWebhook`, { url });
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
        const medication = await firebaseGet(`medications/${medicationId}`);

        if (medication && !medication.taken) {
          await firebasePut(`medications/${medicationId}`, { 
            ...medication, 
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
          const medication = await firebaseGet(`medications/${medicationId}`);
          if (medication && !medication.taken) {
            await sendMedicationReminder({ id: medicationId, ...medication });
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
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

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
  console.log(`📁 Firebase URL: ${FIREBASE_DATABASE_URL}`);
  console.log(`📋 Admin: ${process.env.ADMIN_USERNAME}`);
  console.log(`🤖 Telegram: ${TELEGRAM_BOT_TOKEN ? '✅' : '❌'}`);
  console.log(`🔗 App URL: ${APP_URL}`);
  console.log('='.repeat(50));
});
