# نظام إدارة وتذكير الأدوية

نظام ويب كامل لإدارة الأدوية وتذكير المرضى بمواعيد تناول الأدوية من خلال Telegram Bot.

## المميزات

- إدارة الأدوية (إضافة، تعديل، حذف، عرض)
- إدارة المرضى (إضافة، حذف، عرض)
- تذكير تلقائي عبر Telegram عند موعد الجرعة
- إمكانية تأكيد تناول الدواء من خلال أزرار Inline في Telegram
- لوحة تحكم متكاملة
- دعم كامل للغة العربية (RTL)
- تصميم متجاوب يعمل على جميع الأجهزة
- توقيت مصر (Africa/Cairo)

## التقنيات المستخدمة

- **Backend**: Node.js + Express
- **Database**: Firebase Realtime Database
- **Authentication**: JWT with Cookies
- **Notifications**: Telegram Bot API
- **Scheduler**: node-cron (يعمل كل دقيقة)

## متطلبات التشغيل

- Node.js 16+
- حساب Firebase (Realtime Database)
- حساب Telegram Bot Token
- حساب Vercel (للنشر)

## التثبيت والتشغيل

### 1. استنساخ المشروع

```bash
git clone https://github.com/yourusername/medication-reminder.git
cd medication-reminder
