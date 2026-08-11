const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const axios = require('axios');
const moment = require('moment-timezone');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({
  origin: true,
  credentials: true
}));

// Serve static files
app.use(express.static('public'));

// Initialize Firebase
let firebaseInitialized = false;
let db;

try {
  if (process.env.FIREBASE_CONFIG) {
    const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
    admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig)
    });
    db = admin.database();
    firebaseInitialized = true;
    console.log('Firebase initialized successfully');
  } else {
    console.warn('FIREBASE_CONFIG not found in environment variables');
  }
} catch (error) {
  console.error('Failed to initialize Firebase:', error);
}

// Constants
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'SecurePass123!';
const TIMEZONE = 'Africa/Cairo';

// Default medications
const DEFAULT_MEDICATIONS = [
  { name: 'ايزابريل', time: '12:50', timezone: TIMEZONE },
  { name: 'بانتوبي/بيرولوك', time: '13:07', timezone: TIMEZONE },
  { name: 'ايجيبرو', time: '15:57', timezone: TIMEZONE },
  { name: 'جوسبرين', time: '17:08', timezone: TIMEZONE },
  { name: 'اتور', time: '13:35', timezone: TIMEZONE },
  { name: 'بلافيكس', time: '13:42', timezone: TIMEZONE }
];

// Default patient
const DEFAULT_PATIENT = {
  name: 'لطيف',
  telegramId: null,
  isActive: true,
  createdAt: new Date().toISOString()
};

// Initialize default data
async function initializeDefaultData() {
  if (!firebaseInitialized) return;

  try {
    // Check if medications exist
    const medsRef = db.ref('medications');
    const medsSnapshot = await medsRef.once('value');
    if (!medsSnapshot.exists()) {
      console.log('Adding default medications...');
      const updates = {};
      DEFAULT_MEDICATIONS.forEach((med, index) => {
        updates[index] = {
          ...med,
          id: `med_${Date.now()}_${index}`,
          taken: false,
          lastTaken: null,
          createdAt: new Date().toISOString()
        };
      });
      await medsRef.update(updates);
      console.log('Default medications added');
    }

    // Check if patient exists
    const patientsRef = db.ref('patients');
    const patientsSnapshot = await patientsRef.once('value');
    if (!patientsSnapshot.exists()) {
      console.log('Adding default patient...');
      await patientsRef.push({
        ...DEFAULT_PATIENT,
        id: `patient_${Date.now()}`
      });
      console.log('Default patient added');
    }
  } catch (error) {
    console.error('Error initializing default data:', error);
  }
}

// Middleware to verify JWT
const authenticateToken = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized - No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized - Invalid token' });
  }
};

// Helper function to send Telegram message
async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN not configured');
    return false;
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const payload = {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML'
    };

    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    const response = await axios.post(url, payload);
    return response.data.ok;
  } catch (error) {
    console.error('Error sending Telegram message:', error.response?.data || error.message);
    return false;
  }
}

// Helper function to create inline keyboard
function createMedicationKeyboard(medicationId) {
  return {
    inline_keyboard: [
      [
        {
          text: 'تم التناول',
          callback_data: `take_${medicationId}`
        },
        {
          text: 'تذكير بعد 10 دقائق',
          callback_data: `remind_${medicationId}`
        }
      ]
    ]
  };
}

// Helper function to get medication by ID
async function getMedicationById(id) {
  if (!firebaseInitialized) return null;

  try {
    const medsRef = db.ref('medications');
    const snapshot = await medsRef.orderByChild('id').equalTo(id).once('value');
    if (!snapshot.exists()) return null;

    let medication = null;
    let key = null;
    snapshot.forEach((childSnapshot) => {
      medication = childSnapshot.val();
      key = childSnapshot.key;
    });
    return { ...medication, key };
  } catch (error) {
    console.error('Error getting medication:', error);
    return null;
  }
}

// Helper function to get patient by ID
async function getPatientById(id) {
  if (!firebaseInitialized) return null;

  try {
    const patientsRef = db.ref('patients');
    const snapshot = await patientsRef.once('value');
    if (!snapshot.exists()) return null;

    let patient = null;
    let key = null;
    snapshot.forEach((childSnapshot) => {
      const data = childSnapshot.val();
      if (data.id === id) {
        patient = data;
        key = childSnapshot.key;
      }
    });
    return { ...patient, key };
  } catch (error) {
    console.error('Error getting patient:', error);
    return null;
  }
}

// Helper function to get all patients
async function getAllPatients() {
  if (!firebaseInitialized) return [];

  try {
    const patientsRef = db.ref('patients');
    const snapshot = await patientsRef.once('value');
    if (!snapshot.exists()) return [];

    const patients = [];
    snapshot.forEach((childSnapshot) => {
      const data = childSnapshot.val();
      patients.push({
        ...data,
        key: childSnapshot.key,
        id: data.id || childSnapshot.key
      });
    });
    return patients;
  } catch (error) {
    console.error('Error getting patients:', error);
    return [];
  }
}

// Helper function to get all medications
async function getAllMedications() {
  if (!firebaseInitialized) return [];

  try {
    const medsRef = db.ref('medications');
    const snapshot = await medsRef.once('value');
    if (!snapshot.exists()) return [];

    const medications = [];
    snapshot.forEach((childSnapshot) => {
      const data = childSnapshot.val();
      medications.push({
        ...data,
        key: childSnapshot.key,
        id: data.id || childSnapshot.key
      });
    });
    return medications;
  } catch (error) {
    console.error('Error getting medications:', error);
    return [];
  }
}

// Helper function to get reminders log
async function getReminderLog(medicationId, date) {
  if (!firebaseInitialized) return false;

  try {
    const logRef = db.ref('reminder_log');
    const snapshot = await logRef
      .orderByChild('medicationId')
      .equalTo(medicationId)
      .once('value');

    if (!snapshot.exists()) return false;

    let exists = false;
    snapshot.forEach((childSnapshot) => {
      const log = childSnapshot.val();
      if (log.date === date) {
        exists = true;
      }
    });
    return exists;
  } catch (error) {
    console.error('Error checking reminder log:', error);
    return false;
  }
}

// Helper function to add reminder log
async function addReminderLog(medicationId, date) {
  if (!firebaseInitialized) return false;

  try {
    const logRef = db.ref('reminder_log');
    await logRef.push({
      medicationId,
      date,
      sentAt: new Date().toISOString()
    });
    return true;
  } catch (error) {
    console.error('Error adding reminder log:', error);
    return false;
  }
}

// Scheduler function - check medications and send reminders
async function runScheduler() {
  if (!firebaseInitialized) {
    console.log('Firebase not initialized, skipping scheduler');
    return;
  }

  console.log('Running scheduler...');

  try {
    const now = moment().tz(TIMEZONE);
    const currentTime = now.format('HH:mm');
    const today = now.format('YYYY-MM-DD');

    console.log(`Current time (${TIMEZONE}): ${currentTime}`);

    const medications = await getAllMedications();
    const patients = await getAllPatients();

    if (patients.length === 0) {
      console.log('No patients found');
      return;
    }

    // Filter patients with telegram ID
    const activePatients = patients.filter(p => p.telegramId && p.isActive !== false);

    if (activePatients.length === 0) {
      console.log('No active patients with Telegram IDs');
      return;
    }

    // Check each medication
    for (const medication of medications) {
      // Check if medication time matches current time (within 5 minutes)
      const medTime = moment(medication.time, 'HH:mm');
      const current = moment(currentTime, 'HH:mm');
      const diffMinutes = Math.abs(current.diff(medTime, 'minutes'));

      // Only send reminder if time matches (within 5 minutes) and not taken today
      if (diffMinutes <= 5) {
        // Check if already reminded today
        const alreadyReminded = await getReminderLog(medication.id, today);

        if (!alreadyReminded) {
          console.log(`Sending reminder for ${medication.name} at ${medication.time}`);

          // Send reminder to all active patients
          const message = `تذكير: حان موعد تناول دواء ${medication.name}`;

          for (const patient of activePatients) {
            const success = await sendTelegramMessage(
              patient.telegramId,
              message,
              createMedicationKeyboard(medication.id)
            );

            if (success) {
              console.log(`Reminder sent to ${patient.name}`);
            } else {
              console.log(`Failed to send reminder to ${patient.name}`);
            }
          }

          // Log the reminder
          await addReminderLog(medication.id, today);
        }
      }
    }
  } catch (error) {
    console.error('Error running scheduler:', error);
  }
}

// Schedule the scheduler to run every minute
if (process.env.NODE_ENV !== 'test') {
  cron.schedule('* * * * *', runScheduler, {
    timezone: TIMEZONE
  });
  console.log('Scheduler started - running every minute');
}

// ==================== API ROUTES ====================

// Test route
app.get('/api/test-firebase', async (req, res) => {
  if (!firebaseInitialized) {
    return res.status(500).json({ error: 'Firebase not initialized' });
  }
  try {
    const testRef = db.ref('test');
    await testRef.set({ test: 'success', timestamp: new Date().toISOString() });
    res.json({ success: true, message: 'Firebase connection successful' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get current time in Cairo
app.get('/api/time', (req, res) => {
  const now = moment().tz(TIMEZONE);
  res.json({
    time: now.format('HH:mm:ss'),
    date: now.format('YYYY-MM-DD'),
    timezone: TIMEZONE,
    timestamp: now.toISOString()
  });
});

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = jwt.sign(
      { username, role: 'admin' },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });

    res.json({ success: true, message: 'Login successful' });
  } else {
    res.status(401).json({ error: 'Invalid username or password' });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'Logged out successfully' });
});

// Check auth
app.get('/api/check-auth', (req, res) => {
  const token = req.cookies.token;
  if (!token) {
    return res.json({ authenticated: false });
  }

  try {
    jwt.verify(token, JWT_SECRET);
    res.json({ authenticated: true });
  } catch (error) {
    res.json({ authenticated: false });
  }
});

// Get all medications
app.get('/api/medications', async (req, res) => {
  if (!firebaseInitialized) {
    return res.status(500).json({ error: 'Firebase not initialized' });
  }

  try {
    const medications = await getAllMedications();
    res.json(medications);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Filter medications by date
app.post('/api/medications/filter', async (req, res) => {
  if (!firebaseInitialized) {
    return res.status(500).json({ error: 'Firebase not initialized' });
  }

  try {
    const { date } = req.body;
    const medications = await getAllMedications();

    // For now, return all medications with filter info
    // In a real implementation, you might filter by date
    const filtered = medications.map(med => ({
      ...med,
      filtered: true,
      filterDate: date || 'all'
    }));

    res.json(filtered);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add medication
app.post('/api/medications', authenticateToken, async (req, res) => {
  if (!firebaseInitialized) {
    return res.status(500).json({ error: 'Firebase not initialized' });
  }

  try {
    const { name, time } = req.body;

    if (!name || !time) {
      return res.status(400).json({ error: 'Name and time are required' });
    }

    const medsRef = db.ref('medications');
    const newMed = {
      name,
      time,
      timezone: TIMEZONE,
      taken: false,
      lastTaken: null,
      id: `med_${Date.now()}`,
      createdAt: new Date().toISOString()
    };

    const ref = await medsRef.push(newMed);
    const medication = { ...newMed, key: ref.key };

    res.status(201).json(medication);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark medication as taken
app.put('/api/medications/:id/take', authenticateToken, async (req, res) => {
  if (!firebaseInitialized) {
    return res.status(500).json({ error: 'Firebase not initialized' });
  }

  try {
    const { id } = req.params;
    const medication = await getMedicationById(id);

    if (!medication) {
      return res.status(404).json({ error: 'Medication not found' });
    }

    const medRef = db.ref(`medications/${medication.key}`);
    await medRef.update({
      taken: true,
      lastTaken: new Date().toISOString()
    });

    // Send notification to all patients
    const patients = await getAllPatients();
    const activePatients = patients.filter(p => p.telegramId && p.isActive !== false);

    if (activePatients.length > 0) {
      const message = `تم تناول دواء ${medication.name} الساعة ${moment().tz(TIMEZONE).format('HH:mm')}`;
      for (const patient of activePatients) {
        await sendTelegramMessage(patient.telegramId, message);
      }
    }

    res.json({ success: true, message: 'Medication marked as taken' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete medication
app.delete('/api/medications/:id', authenticateToken, async (req, res) => {
  if (!firebaseInitialized) {
    return res.status(500).json({ error: 'Firebase not initialized' });
  }

  try {
    const { id } = req.params;
    const medication = await getMedicationById(id);

    if (!medication) {
      return res.status(404).json({ error: 'Medication not found' });
    }

    const medRef = db.ref(`medications/${medication.key}`);
    await medRef.remove();

    res.json({ success: true, message: 'Medication deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all patients
app.get('/api/patients', authenticateToken, async (req, res) => {
  if (!firebaseInitialized) {
    return res.status(500).json({ error: 'Firebase not initialized' });
  }

  try {
    const patients = await getAllPatients();
    res.json(patients);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add patient
app.post('/api/patients', authenticateToken, async (req, res) => {
  if (!firebaseInitialized) {
    return res.status(500).json({ error: 'Firebase not initialized' });
  }

  try {
    const { name, telegramId } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const patientsRef = db.ref('patients');
    const newPatient = {
      name,
      telegramId: telegramId || null,
      isActive: true,
      id: `patient_${Date.now()}`,
      createdAt: new Date().toISOString()
    };

    const ref = await patientsRef.push(newPatient);
    const patient = { ...newPatient, key: ref.key };

    res.status(201).json(patient);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete patient
app.delete('/api/patients/:id', authenticateToken, async (req, res) => {
  if (!firebaseInitialized) {
    return res.status(500).json({ error: 'Firebase not initialized' });
  }

  try {
    const { id } = req.params;
    const patient = await getPatientById(id);

    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    const patientRef = db.ref(`patients/${patient.key}`);
    await patientRef.remove();

    res.json({ success: true, message: 'Patient deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test Telegram
app.post('/api/telegram/test', authenticateToken, async (req, res) => {
  try {
    const { telegramId } = req.body;

    if (!telegramId) {
      return res.status(400).json({ error: 'Telegram ID is required' });
    }

    const success = await sendTelegramMessage(
      telegramId,
      'هذا رسالة اختبارية من نظام تذكير الأدوية'
    );

    if (success) {
      res.json({ success: true, message: 'Test message sent successfully' });
    } else {
      res.status(500).json({ error: 'Failed to send test message' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Set webhook
app.post('/api/telegram/set-webhook', authenticateToken, async (req, res) => {
  try {
    const { webhookUrl } = req.body;

    if (!webhookUrl) {
      return res.status(400).json({ error: 'Webhook URL is required' });
    }

    if (!TELEGRAM_BOT_TOKEN) {
      return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not configured' });
    }

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`;
    const response = await axios.post(url, {
      url: webhookUrl
    });

    if (response.data.ok) {
      res.json({ success: true, message: 'Webhook set successfully', data: response.data });
    } else {
      res.status(500).json({ error: 'Failed to set webhook', data: response.data });
    }
  } catch (error) {
    res.status(500).json({ error: error.response?.data?.description || error.message });
  }
});

// Get webhook info
app.get('/api/telegram/webhook-info', authenticateToken, async (req, res) => {
  try {
    if (!TELEGRAM_BOT_TOKEN) {
      return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not configured' });
    }

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo`;
    const response = await axios.get(url);

    if (response.data.ok) {
      res.json(response.data.result);
    } else {
      res.status(500).json({ error: 'Failed to get webhook info', data: response.data });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Telegram webhook endpoint
app.post('/api/webhook/telegram', async (req, res) => {
  try {
    const { message, callback_query } = req.body;

    // Handle callback queries (button clicks)
    if (callback_query) {
      const { data, from, message: msg } = callback_query;

      if (data.startsWith('take_')) {
        const medicationId = data.replace('take_', '');
        const medication = await getMedicationById(medicationId);

        if (medication) {
          const medRef = db.ref(`medications/${medication.key}`);
          await medRef.update({
            taken: true,
            lastTaken: new Date().toISOString()
          });

          await sendTelegramMessage(
            from.id,
            `تم تسجيل تناول دواء ${medication.name} بنجاح`
          );

          // Notify all patients
          const patients = await getAllPatients();
          const activePatients = patients.filter(p => p.telegramId && p.isActive !== false);
          const message = `تم تناول دواء ${medication.name} الساعة ${moment().tz(TIMEZONE).format('HH:mm')}`;
          for (const patient of activePatients) {
            await sendTelegramMessage(patient.telegramId, message);
          }

          // Answer callback query
          await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
            {
              callback_query_id: callback_query.id,
              text: 'تم تسجيل التناول بنجاح'
            }
          );
        }
      } else if (data.startsWith('remind_')) {
        const medicationId = data.replace('remind_', '');
        const medication = await getMedicationById(medicationId);

        if (medication) {
          // Send reminder after 10 minutes
          setTimeout(async () => {
            const message = `تذكير: حان موعد تناول دواء ${medication.name}`;
            await sendTelegramMessage(
              from.id,
              message,
              createMedicationKeyboard(medicationId)
            );
          }, 10 * 60 * 1000);

          await sendTelegramMessage(
            from.id,
            `تم تأجيل تذكير دواء ${medication.name} لمدة 10 دقائق`
          );

          // Answer callback query
          await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
            {
              callback_query_id: callback_query.id,
              text: 'تم تأجيل التذكير 10 دقائق'
            }
          );
        }
      }

      res.sendStatus(200);
      return;
    }

    // Handle regular messages
    if (message && message.text) {
      console.log(`Received message from ${message.from.id}: ${message.text}`);

      // Store Telegram ID if patient exists
      const patients = await getAllPatients();
      const patient = patients.find(p => p.name === 'لطيف');

      if (patient && !patient.telegramId) {
        const patientRef = db.ref(`patients/${patient.key}`);
        await patientRef.update({
          telegramId: message.from.id
        });
        await sendTelegramMessage(
          message.from.id,
          'تم تسجيل حسابك بنجاح في نظام تذكير الأدوية'
        );
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
});

// Run scheduler manually
app.get('/api/scheduler', async (req, res) => {
  try {
    await runScheduler();
    res.json({ success: true, message: 'Scheduler executed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Initialize default data
initializeDefaultData();

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Timezone: ${TIMEZONE}`);
});

module.exports = app;
