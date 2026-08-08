require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const path = require('path');
const axios = require('axios');

const app = express();

// ============ FIREBASE SETUP ============
console.log('Initializing Firebase...');

let firebaseConfig;
try {
  firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  console.log('Firebase config parsed successfully');
} catch (error) {
  console.error('Failed to parse FIREBASE_CONFIG:', error.message);
  process.exit(1);
}

const FIREBASE_DATABASE_URL = firebaseConfig.databaseURL || `https://${firebaseConfig.project_id}.firebaseio.com`;
console.log(`Firebase Database URL: ${FIREBASE_DATABASE_URL}`);

// ============ TELEGRAM SETUP ============
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
// IMPORTANT: Use real URL, not markdown
const APP_URL = process.env.APP_URL || 'https://medication-reminder-latif.vercel.app';

// ============ MIDDLEWARE ============
// Helmet for security headers
app.use(helmet({ 
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false 
}));

// CORS - محدود و آمن
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3000', 'https://medication-reminder-latif.vercel.app'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie']
}));

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ============ RATE LIMITERS ============
// 1. General API rate limiter - 300 requests per 15 minutes
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false, // Disable X-RateLimit-* headers
  message: {
    error: 'تم تجاوز عدد الطلبات المسموح بها، يرجى المحاولة بعد 15 دقيقة',
    retryAfter: '15 دقيقة'
  },
  skip: (req) => {
    // Skip rate limiting for scheduler and webhook
    return req.path === '/api/scheduler' || 
           req.path === '/api/webhook/telegram' ||
           req.path === '/api/time';
  }
});

// 2. Strict login rate limiter - 5 attempts per 15 minutes
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'محاولات تسجيل دخول كثيرة جداً، يرجى المحاولة بعد 15 دقيقة',
    retryAfter: '15 دقيقة'
  }
});

app.use('/api/', apiLimiter);
app.use('/api/login', loginLimiter);

// ============ AUTH MIDDLEWARE ============
const authenticateToken = (req, res, next) => {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'غير مصرح به - الرجاء تسجيل الدخول' });
  }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      res.status(403).json({ error: 'انتهت صلاحية الجلسة، الرجاء تسجيل الدخول مرة أخرى' });
    } else {
      res.status(403).json({ error: 'جلسة غير صالحة' });
    }
  }
};

// ============ FIREBASE HELPER FUNCTIONS ============
// Using a single axios instance with timeout
const firebaseAxios = axios.create({
  timeout: 10000, // 10 seconds timeout
  headers: {
    'Content-Type': 'application/json'
  }
});

async function firebaseGet(path) {
  try {
    const url = `${FIREBASE_DATABASE_URL}/${path}.json`;
    const response = await firebaseAxios.get(url);
    return response.data || {};
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      console.error(`Firebase GET timeout (${path})`);
      throw new Error('انتهت مهلة الاتصال بقاعدة البيانات');
    }
    console.error(`Firebase GET error (${path}):`, error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    throw new Error(`خطأ في جلب البيانات: ${error.message}`);
  }
}

async function firebasePost(path, data) {
  try {
    const url = `${FIREBASE_DATABASE_URL}/${path}.json`;
    const response = await firebaseAxios.post(url, data);
    return response.data;
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      console.error(`Firebase POST timeout (${path})`);
      throw new Error('انتهت مهلة الاتصال بقاعدة البيانات');
    }
    console.error(`Firebase POST error (${path}):`, error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    throw new Error(`خطأ في إضافة البيانات: ${error.message}`);
  }
}

async function firebasePut(path, data) {
  try {
    const url = `${FIREBASE_DATABASE_URL}/${path}.json`;
    const response = await firebaseAxios.put(url, data);
    return response.data;
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      console.error(`Firebase PUT timeout (${path})`);
      throw new Error('انتهت مهلة الاتصال بقاعدة البيانات');
    }
    console.error(`Firebase PUT error (${path}):`, error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    throw new Error(`خطأ في تحديث البيانات: ${error.message}`);
  }
}

async function firebaseDelete(path) {
  try {
    const url = `${FIREBASE_DATABASE_URL}/${path}.json`;
    const response = await firebaseAxios.delete(url);
    return response.data;
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      console.error(`Firebase DELETE timeout (${path})`);
      throw new Error('انتهت مهلة الاتصال بقاعدة البيانات');
    }
    console.error(`Firebase DELETE error (${path}):`, error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    throw new Error(`خطأ في حذف البيانات: ${error.message}`);
  }
}

// ============ TELEGRAM FUNCTIONS ============
const telegramAxios = axios.create({
  timeout: 15000, // 15 seconds timeout
  headers: {
    'Content-Type': 'application/json'
  }
});

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
    const response = await telegramAxios.post(`${TELEGRAM_API}/sendMessage`, payload);
    return response.data;
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      console.error('Telegram timeout for chatId:', chatId);
      throw new Error('انتهت مهلة الاتصال بـ Telegram');
    }
    if (error.response) {
      console.error('Telegram API error:', error.response.data);
      if (error.response.data.error_code === 429) {
        console.error('Rate limited by Telegram, waiting...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        // Retry once after waiting
        return await sendTelegramMessage(chatId, text, keyboard);
      }
    }
    console.error('Telegram error for chatId', chatId, ':', error.message);
    throw error;
  }
}

async function sendWelcomeMessage(chatId, patientName) {
  const message = `مرحبا ${patientName}!

تم تسجيلك في نظام تذكير الأدوية. ستتلقى إشعارات عند مواعيد الأدوية.

لمتابعة الأدوية: ${APP_URL}`;
  
  try {
    await sendTelegramMessage(chatId, message);
  } catch (error) {
    console.error(`Failed to send welcome message to ${patientName}:`, error.message);
  }
}

async function sendTestMessage(chatId) {
  const message = `هذه رسالة اختبارية من نظام تذكير الأدوية

لمتابعة الأدوية: ${APP_URL}`;
  
  try {
    await sendTelegramMessage(chatId, message);
  } catch (error) {
    console.error('Failed to send test message:', error.message);
    throw error;
  }
}

async function sendDailySummary(chatId, date) {
  const message = `✅ يوم ${date} انتهى

📋 تم تذكير جميع الأدوية المقررة.

غداً إن شاء الله نلتقي مع أدوية جديدة.

لمتابعة الأدوية: ${APP_URL}`;
  
  try {
    await sendTelegramMessage(chatId, message);
  } catch (error) {
    console.error(`Failed to send daily summary to ${chatId}:`, error.message);
  }
}

// Unified function to send medication reminder to all patients
async function sendMedicationReminderToAll(medication) {
  const patients = await firebaseGet('patients');
  const message = `💊 تذكير بتناول الدواء

الدواء: ${medication.name}
الجرعة: ${medication.dosage}
الموعد: ${medication.time}
التاريخ: ${medication.date}

يرجى تناول الدواء في الموعد المحدد

لمتابعة الأدوية: ${APP_URL}`;
  
  const keyboard = [
    [
      { text: '✅ تم التناول', callback_data: `taken_${medication.id}` },
      { text: '⏰ تذكير بعد 10 دقائق', callback_data: `remind_later_${medication.id}` }
    ]
  ];

  let successCount = 0;
  let failCount = 0;

  for (const [id, patient] of Object.entries(patients)) {
    if (patient.chatId) {
      try {
        await sendTelegramMessage(patient.chatId, message, keyboard);
        successCount++;
      } catch (error) {
        console.error(`Failed to send reminder to ${patient.name} (${patient.chatId}):`, error.message);
        failCount++;
      }
    }
  }

  console.log(`Sent reminders to ${successCount} patients, failed: ${failCount}`);
  return { successCount, failCount };
}

async function sendMedicationReminderToPatient(chatId, medication) {
  const message = `💊 تذكير بتناول الدواء

الدواء: ${medication.name}
الجرعة: ${medication.dosage}
الموعد: ${medication.time}
التاريخ: ${medication.date}

يرجى تناول الدواء في الموعد المحدد

لمتابعة الأدوية: ${APP_URL}`;
  
  const keyboard = [
    [
      { text: '✅ تم التناول', callback_data: `taken_${medication.id}` },
      { text: '⏰ تذكير بعد 10 دقائق', callback_data: `remind_later_${medication.id}` }
    ]
  ];

  await sendTelegramMessage(chatId, message, keyboard);
}

async function notifyMedicationTaken(medication) {
  const patients = await firebaseGet('patients');
  const message = `✅ تم تناول الدواء

الدواء: ${medication.name}
الجرعة: ${medication.dosage}
الوقت: ${medication.time}
التاريخ: ${medication.date}

تم التأكيد: ${new Date().toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' })}

لمتابعة الأدوية: ${APP_URL}`;
  
  for (const [id, patient] of Object.entries(patients)) {
    if (patient.chatId) {
      try {
        await sendTelegramMessage(patient.chatId, message);
      } catch (error) {
        console.error(`Failed to notify ${patient.name}:`, error.message);
      }
    }
  }
}

// ============ SCHEDULER ROUTE ============
// NOTE: This runs on Vercel Serverless - no memory state
// Uses Firebase for persistent state to prevent duplicate runs
app.get('/api/scheduler', async (req, res) => {
  try {
    console.log('📋 Running scheduler task...');
    const cairoTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
    const currentTime = cairoTime.getHours().toString().padStart(2, '0') + ':' + 
                        cairoTime.getMinutes().toString().padStart(2, '0');
    const currentDate = cairoTime.toISOString().split('T')[0];
    const now = cairoTime.getTime();
    
    console.log(`🕐 Checking medications for ${currentDate} at ${currentTime}`);

    // Check if we have a reminder lock to prevent concurrent runs
    const lockKey = `scheduler_lock_${currentDate}_${currentTime}`;
    const lockData = await firebaseGet(`system_locks/${lockKey}`);
    
    // If lock exists and is less than 5 minutes old, skip
    if (lockData && lockData.locked) {
      const lockAge = now - lockData.timestamp;
      if (lockAge < 300000) { // 5 minutes
        console.log(`⏭️ Scheduler already ran for this time (lock age: ${Math.round(lockAge/1000)}s), skipping...`);
        return res.status(200).json({
          success: true,
          message: 'Skipped - already processed this time slot',
          skipped: true,
          lockAge: Math.round(lockAge/1000)
        });
      }
    }

    // Try to acquire lock atomically
    await firebasePut(`system_locks/${lockKey}`, {
      locked: true,
      timestamp: now,
      startedBy: process.env.VERCEL_URL || 'unknown',
      instance: process.env.NEXT_RUNTIME || 'vercel'
    });

    // Get all medications
    const medications = await firebaseGet('medications');
    let remindersSent = 0;
    let delayedRemindersProcessed = 0;
    let matchedMeds = [];

    // Process each medication
    for (const [id, med] of Object.entries(medications)) {
      // Skip if medication is inactive, already taken, or doesn't match time/date
      if (!med.active || med.taken || med.time !== currentTime || med.date !== currentDate) {
        continue;
      }

      matchedMeds.push({ id, ...med });

      // Check if reminder was already sent for this medication time slot
      const reminderKey = `reminder_sent_${id}_${currentDate}_${currentTime}`;
      const reminderSent = await firebaseGet(`reminders/sent/${reminderKey}`);

      if (!reminderSent) {
        console.log(`💊 Sending reminder for: ${med.name} at ${currentTime}`);
        
        // Send to all patients
        const { successCount, failCount } = await sendMedicationReminderToAll({ id, ...med });
        remindersSent += successCount;

        // Mark reminder as sent persistently
        await firebasePut(`reminders/sent/${reminderKey}`, {
          sent: true,
          timestamp: new Date().toISOString(),
          sentTo: successCount,
          failedTo: failCount
        });

        // Log medication at this time
        await firebasePost(`reminders/logs/${id}_${currentDate}_${currentTime}`, {
          medicationId: id,
          medicationName: med.name,
          time: currentTime,
          date: currentDate,
          sentAt: new Date().toISOString(),
          recipients: successCount
        });
      }

      // Check for pending delayed reminders (10 minutes later)
      const delayedReminderKey = `delayed_${id}_${currentDate}`;
      const delayedReminders = await firebaseGet(`reminders/delayed/${delayedReminderKey}`);
      
      if (delayedReminders) {
        // Process delayed reminders that are due
        const nowTimestamp = Date.now();
        for (const [reminderId, reminder] of Object.entries(delayedReminders)) {
          if (!reminder.sent && reminder.remindAt <= nowTimestamp) {
            console.log(`⏰ Processing delayed reminder for ${med.name}`);
            await sendMedicationReminderToAll({ id, ...med });
            await firebasePut(`reminders/delayed/${delayedReminderKey}/${reminderId}/sent`, true);
            delayedRemindersProcessed++;
          }
        }
      }
    }

    console.log(`✅ Sent ${remindersSent} reminders, processed ${delayedRemindersProcessed} delayed reminders`);
    
    // Keep lock active for 5 minutes to prevent duplicate runs
    await firebasePut(`system_locks/${lockKey}`, {
      locked: true,
      timestamp: now,
      completed: true,
      completedAt: new Date().toISOString(),
      remindersSent: remindersSent,
      delayedProcessed: delayedRemindersProcessed
    });

    res.status(200).json({
      success: true,
      message: 'Scheduler executed successfully',
      remindersSent: remindersSent,
      delayedRemindersProcessed: delayedRemindersProcessed,
      time: currentTime,
      date: currentDate,
      matchedMedications: matchedMeds.map(m => m.name),
      totalMedications: Object.keys(medications).length
    });
  } catch (error) {
    console.error('🔥 Scheduler error:', error);
    console.error('Stack trace:', error.stack);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'production' ? undefined : error.stack
    });
  }
});

// ============ TIME CHECK ROUTE ============
app.get('/api/time', async (req, res) => {
  const now = new Date();
  const cairoTime = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
  
  res.json({
    utc: now.toISOString(),
    cairo: cairoTime.toISOString(),
    cairoTime: cairoTime.getHours().toString().padStart(2, '0') + ':' + 
               cairoTime.getMinutes().toString().padStart(2, '0'),
    cairoDate: cairoTime.toISOString().split('T')[0],
    timezone: 'Africa/Cairo'
  });
});

// ============ TEST ROUTE ============
app.get('/api/test-firebase', async (req, res) => {
  console.log('🔬 Testing Firebase connection...');
  try {
    const testData = {
      timestamp: new Date().toISOString(),
      status: 'connected',
      test: 'Hello from Vercel!',
      environment: process.env.VERCEL_ENV || 'development'
    };
    
    await firebasePut('test_connection', testData);
    const data = await firebaseGet('test_connection');
    
    res.json({
      success: true,
      message: '✅ Firebase is connected!',
      databaseURL: FIREBASE_DATABASE_URL,
      data: data
    });
  } catch (error) {
    console.error('Firebase test failed:', error);
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
    const token = jwt.sign(
      { username, role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    // Set secure cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
      path: '/'
    });
    
    // Do NOT return token in body for security
    return res.json({
      success: true,
      message: 'تم تسجيل الدخول بنجاح'
    });
  }
  res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  });
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
    console.log(`📊 Found ${allMeds.length} medications`);
    res.json(allMeds);
  } catch (error) {
    console.error('Error fetching medications:', error);
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
    
    // Reset taken status for medications on this date
    for (const [id, med] of Object.entries(medications)) {
      const medDate = med.date || med.createdAt?.split('T')[0];
      if (medDate === date && med.taken === true) {
        await firebasePut(`medications/${id}`, { ...med, taken: false });
      }
    }
    
    const updatedMedications = await firebaseGet('medications');
    const filteredMeds = Object.entries(updatedMedications)
      .filter(([id, med]) => {
        const medDate = med.date || med.createdAt?.split('T')[0];
        return medDate === date;
      })
      .map(([id, med]) => ({ id, ...med, taken: med.taken || false }));
    
    // Send daily summary if filtering for today
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
    res.status(500).json({ error: 'حدث خطأ في تصفية الأدوية', details: error.message });
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

    const result = await firebasePost('medications', newMed);

    console.log(`✅ Medication added: ${result.name}`);
    res.status(201).json({
      success: true,
      id: result.name,
      medication: { id: result.name, ...newMed },
      message: 'تم إضافة الدواء بنجاح'
    });
  } catch (error) {
    console.error('Error adding medication:', error);
    res.status(500).json({ error: 'حدث خطأ في إضافة الدواء', details: error.message });
  }
});

app.put('/api/medications/:id/take', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { patientName } = req.body;

  try {
    console.log(`✅ Marking medication as taken: ${id}`);
    const medication = await firebaseGet(`medications/${id}`);
    if (!medication) {
      return res.status(404).json({ error: 'الدواء غير موجود' });
    }

    if (medication.taken) {
      return res.status(400).json({ error: 'تم تناول هذا الدواء بالفعل' });
    }

    await firebasePut(`medications/${id}`, {
      ...medication,
      taken: true,
      takenAt: new Date().toISOString()
    });

    await notifyMedicationTaken({ id, ...medication });

    console.log(`✅ Medication marked as taken: ${id}`);
    res.json({
      success: true,
      message: 'تم تسجيل تناول الدواء وإرسال الإشعار'
    });
  } catch (error) {
    console.error('Error marking medication as taken:', error);
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
    console.log(`🗑️ Medication deleted: ${id}`);
    res.json({ success: true, message: 'تم حذف الدواء بنجاح' });
  } catch (error) {
    console.error('Error deleting medication:', error);
    res.status(500).json({
      error: 'حدث خطأ في حذف الدواء',
      details: error.message
    });
  }
});

// ============ PATIENT ROUTES ============
app.get('/api/patients', authenticateToken, async (req, res) => {
  try {
    console.log('👥 Fetching patients...');
    const patients = await firebaseGet('patients');
    const allPatients = Object.entries(patients).map(([id, patient]) => ({ id, ...patient }));
    console.log(`👥 Found ${allPatients.length} patients`);
    res.json(allPatients);
  } catch (error) {
    console.error('Error fetching patients:', error);
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

    await sendWelcomeMessage(chatId, name);

    console.log(`✅ Patient added: ${result.name}`);
    res.status(201).json({
      success: true,
      id: result.name,
      patient: { id: result.name, ...newPatient },
      message: 'تم إضافة المريض وإرسال رسالة الترحيب'
    });
  } catch (error) {
    console.error('Error adding patient:', error);
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
    console.log(`🗑️ Patient deleted: ${id}`);
    res.json({ success: true, message: 'تم حذف المريض بنجاح' });
  } catch (error) {
    console.error('Error deleting patient:', error);
    res.status(500).json({
      error: 'حدث خطأ في حذف المريض',
      details: error.message
    });
  }
});

// ============ TELEGRAM ROUTES ============
app.post('/api/telegram/test', authenticateToken, async (req, res) => {
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'الرجاء إدخال Chat ID' });

  try {
    console.log(`📱 Testing Telegram: ${chatId}`);
    await sendTestMessage(chatId);
    res.json({ success: true, message: 'تم إرسال رسالة الاختبار بنجاح' });
  } catch (error) {
    console.error('Telegram test error:', error);
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
    const response = await telegramAxios.post(`${TELEGRAM_API}/setWebhook`, { url });
    res.json({
      success: true,
      message: 'تم تعيين Webhook بنجاح',
      data: response.data
    });
  } catch (error) {
    console.error('Set webhook error:', error);
    res.status(500).json({
      error: 'فشل في تعيين Webhook',
      details: error.message
    });
  }
});

app.get('/api/telegram/webhook-info', authenticateToken, async (req, res) => {
  try {
    console.log('📊 Getting webhook info...');
    const response = await telegramAxios.get(`${TELEGRAM_API}/getWebhookInfo`);
    res.json(response.data);
  } catch (error) {
    console.error('Get webhook error:', error);
    res.status(500).json({
      error: 'فشل في جلب معلومات Webhook',
      details: error.message
    });
  }
});

// ============ TELEGRAM WEBHOOK ============
app.post('/api/webhook/telegram', express.json(), async (req, res) => {
  try {
    const { callback_query, message } = req.body;
    
    if (callback_query) {
      const { data, from, id: callbackId } = callback_query;
      const chatId = from.id;

      // Answer callback query immediately to prevent timeout
      try {
        await telegramAxios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
          callback_query_id: callbackId
        });
      } catch (error) {
        console.error('Failed to answer callback query:', error.message);
      }

      if (data && data.startsWith('taken_')) {
        const medicationId = data.replace('taken_', '');
        const medication = await firebaseGet(`medications/${medicationId}`);

        if (medication) {
          if (!medication.taken) {
            // Use a lock to prevent double processing
            const lockKey = `take_lock_${medicationId}_${Date.now()}`;
            await firebasePut(`system_locks/${lockKey}`, {
              locked: true,
              timestamp: Date.now(),
              chatId: chatId
            });

            await firebasePut(`medications/${medicationId}`, {
              ...medication,
              taken: true,
              takenAt: new Date().toISOString(),
              takenBy: chatId
            });

            // Send confirmation to the user who took it
            await sendTelegramMessage(chatId, `✅ تم تسجيل تناول ${medication.name}`);

            // Notify all patients
            await notifyMedicationTaken({ id: medicationId, ...medication });
          } else {
            await sendTelegramMessage(chatId, `ℹ️ ${medication.name} تم تناوله بالفعل`);
          }
        } else {
          await sendTelegramMessage(chatId, '❌ الدواء غير موجود');
        }
      } else if (data && data.startsWith('remind_later_')) {
        const medicationId = data.replace('remind_later_', '');
        
        // Store delayed reminder in Firebase
        const cairoTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
        const currentDate = cairoTime.toISOString().split('T')[0];
        const remindAt = Date.now() + 10 * 60 * 1000; // 10 minutes from now
        const delayedKey = `delayed_${medicationId}_${currentDate}`;
        
        await firebasePost(`reminders/delayed/${delayedKey}`, {
          medicationId: medicationId,
          chatId: chatId,
          remindAt: remindAt,
          sent: false,
          createdAt: new Date().toISOString()
        });

        await sendTelegramMessage(chatId, `⏰ سيتم التذكير بعد 10 دقائق`);
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ Webhook error:', error);
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

// ============ EXPORT FOR VERCEL ============
// Vercel expects module.exports = app
module.exports = app;

// For local development only
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📁 Firebase URL: ${FIREBASE_DATABASE_URL}`);
    console.log(`👤 Admin: ${process.env.ADMIN_USERNAME}`);
    console.log(`🤖 Telegram: ${TELEGRAM_BOT_TOKEN ? '✅ Configured' : '❌ Missing'}`);
    console.log(`🌐 App URL: ${APP_URL}`);
    console.log('='.repeat(50));
  });
}
