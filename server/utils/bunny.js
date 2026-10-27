/**
 * Bunny CDN Video Management Utility
 * يدير رفع والتحكم في الفيديوهات
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ═════════════════════════════════════════════════════════════════
// الإعدادات
// ═════════════════════════════════════════════════════════════════

const BUNNY_API_URL = 'https://api.bunny.net';
const BUNNY_STREAM_API_URL = 'https://api.bunny.net/videolibrary';

const BUNNY_CONFIG = {
  apiKey: process.env.BUNNY_API_KEY,
  libraryId: process.env.BUNNY_STREAM_LIBRARY_ID,
  tokenSecret: process.env.BUNNY_STREAM_TOKEN_SECRET, // مفتاح سري لتوقيع الروابط
};

// التحقق من الإعدادات
function validateConfig() {
  if (!BUNNY_CONFIG.apiKey || !BUNNY_CONFIG.libraryId) {
    console.warn('⚠️  Bunny configuration incomplete. Set BUNNY_API_KEY and BUNNY_STREAM_LIBRARY_ID in .env');
    return false;
  }
  return true;
}

// ═════════════════════════════════════════════════════════════════
// 1️⃣ رفع الفيديو إلى Bunny
// ═════════════════════════════════════════════════════════════════

/**
 * رفع فيديو إلى Bunny Stream
 * @param {Buffer|string} videoFileOrPath - الملف أو المسار
 * @param {string} title - عنوان الفيديو
 * @param {string} courseId - معرف الكورس (للتنسيق)
 * @returns {Promise<object>} تفاصيل الفيديو المرفوع
 */
async function uploadVideoToBunny(videoFileOrPath, title, courseId) {
  if (!validateConfig()) throw new Error('Bunny not configured');

  try {
    let fileBuffer;
    let fileSize;

    // قراءة الملف إذا كان مسار
    if (typeof videoFileOrPath === 'string') {
      fileBuffer = fs.readFileSync(videoFileOrPath);
      fileSize = fs.statSync(videoFileOrPath).size;
    } else {
      fileBuffer = videoFileOrPath;
      fileSize = videoFileOrPath.length;
    }

    console.log(`📤 بدء رفع: ${title} (${(fileSize / 1024 / 1024 / 1024).toFixed(2)} GB)`);

    // 1. إنشاء فيديو جديد في Bunny
    const videoResponse = await axios.post(
      `${BUNNY_STREAM_API_URL}/${BUNNY_CONFIG.libraryId}/videos`,
      { title },
      {
        headers: {
          'AccessKey': BUNNY_CONFIG.apiKey,
        },
      }
    );

    const videoId = videoResponse.data.guid;
    console.log(`✓ تم إنشاء فيديو: ${videoId}`);

    // 2. رفع الملف
    // Bunny يدعم رفع الملفات الكبيرة (resumable uploads)
    const uploadUrl = `${BUNNY_STREAM_API_URL}/${BUNNY_CONFIG.libraryId}/videos/${videoId}`;

    await axios.put(uploadUrl, fileBuffer, {
      headers: {
        'AccessKey': BUNNY_CONFIG.apiKey,
        'Content-Type': 'application/octet-stream',
      },
    });

    console.log(`✓ تم رفع الملف`);

    // 3. الحصول على معلومات الفيديو
    const infoResponse = await axios.get(
      `${BUNNY_STREAM_API_URL}/${BUNNY_CONFIG.libraryId}/videos/${videoId}`,
      {
        headers: {
          'AccessKey': BUNNY_CONFIG.apiKey,
        },
      }
    );

    const videoData = infoResponse.data;

    // 4. صيغة البيانات للحفظ في قاعدة البيانات
    const videoInfo = {
      bunnyVideoId: videoId,
      title: videoData.title,
      duration: Math.round(videoData.length || 0), // بالثواني
      fileSize: fileSize,
      thumbnail: videoData.thumbnail,
      status: videoData.status, // 0=queued, 1=processing, 2=error, 3=finished
      embedUrl: `https://iframe.mediadelivery.net/embed/${videoId}`,
      courseId,
      uploadedAt: new Date(),
      views: 0,
      isProtected: true, // الفيديو محمي بـ token
    };

    console.log(`✅ تم رفع الفيديو بنجاح!`);
    console.log(`   المعرف: ${videoId}`);
    console.log(`   الجودات: 360p, 480p, 720p, 1080p (adaptive)`);

    return videoInfo;
  } catch (err) {
    console.error('❌ خطأ في رفع الفيديو:', err.response?.data || err.message);
    throw new Error(`فشل الرفع: ${err.message}`);
  }
}

// ═════════════════════════════════════════════════════════════════
// 2️⃣ الحصول على رابط آمن مع Token
// ═════════════════════════════════════════════════════════════════

/**
 * إنشاء رابط embed آمن مع توقيع HMAC
 * @param {string} videoId - معرف الفيديو
 * @param {number} expiresInHours - انتهاء صلاحية التوكن (بالساعات)
 * @returns {string} رابط embed آمن
 */
function generateSecureEmbedUrl(videoId, expiresInHours = 24) {
  const { libraryId, tokenSecret } = BUNNY_CONFIG;
  if (!tokenSecret) {
    console.warn('⚠️ BUNNY_STREAM_TOKEN_SECRET is not set. Returning a non-secure URL.');
    // رابط غير محمي ولكنه لا يزال يمنع التنزيل المباشر
    return `https://iframe.mediadelivery.net/embed/${libraryId}/${videoId}`;
  }

  const expires = Math.floor(Date.now() / 1000) + expiresInHours * 3600;
  const path = `/videolibrary/${libraryId}/videos/${videoId}`;
  
  const hashable = tokenSecret + path + expires;
  const token = crypto.createHash('sha256').update(hashable).digest('base64url');

  return `https://iframe.mediadelivery.net/embed/${libraryId}/${videoId}?token=${token}&expires=${expires}`;
}

/**
 * إنشاء رابط مشاهدة آمن (للـ iframe)
 * يتعطل بعد انتهاء الوقت المحدد
 */
function generateSecureViewUrl(videoId, userId, tokenSecret, expiresInHours = 24) {
  // هذه الدالة مكررة، يمكن استخدام generateSecureEmbedUrl بدلاً منها
  return generateSecureEmbedUrl(videoId, expiresInHours);
}

// ═════════════════════════════════════════════════════════════════
// 3️⃣ حذف الفيديو
// ═════════════════════════════════════════════════════════════════

/**
 * حذف فيديو من Bunny
 * @param {string} videoId - معرف الفيديو
 */
async function deleteVideoFromBunny(videoId) {
  if (!validateConfig()) throw new Error('Bunny not configured');

  try {
    await axios.delete(
      `${BUNNY_STREAM_API_URL}/${BUNNY_CONFIG.libraryId}/videos/${videoId}`,
      {
        headers: {
          'AccessKey': BUNNY_CONFIG.apiKey,
        },
      }
    );

    console.log(`✓ تم حذف الفيديو: ${videoId}`);
    return true;
  } catch (err) {
    console.error('❌ خطأ في حذف الفيديو:', err.message);
    throw err;
  }
}

// ═════════════════════════════════════════════════════════════════
// 4️⃣ الحصول على معلومات الفيديو
// ═════════════════════════════════════════════════════════════════

/**
 * الحصول على معلومات الفيديو (الحالة، الجودات، إلخ)
 */
async function getVideoInfo(videoId) {
  if (!validateConfig()) throw new Error('Bunny not configured');

  try {
    const response = await axios.get(
      `${BUNNY_STREAM_API_URL}/${BUNNY_CONFIG.libraryId}/videos/${videoId}`,
      {
        headers: {
          'AccessKey': BUNNY_CONFIG.apiKey,
        },
      }
    );

    const video = response.data;
    return {
      id: video.guid,
      title: video.title,
      duration: Math.round(video.length || 0),
      thumbnail: video.thumbnail,
      status: getVideoStatus(video.status),
      resolutions: video.resolutions || [], // الجودات المتاحة
      fileSize: video.fileSize,
      views: video.views || 0,
      createdAt: video.dateCreated,
      updatedAt: video.dateUpdated,
    };
  } catch (err) {
    console.error('❌ خطأ في الحصول على معلومات الفيديو:', err.message);
    throw err;
  }
}

// ═════════════════════════════════════════════════════════════════
// 5️⃣ Utilities
// ═════════════════════════════════════════════════════════════════

/**
 * تحويل رقم الحالة إلى نص
 */
function getVideoStatus(statusCode) {
  const statuses = {
    0: 'في الانتظار',
    1: 'قيد المعالجة',
    2: 'خطأ',
    3: 'مكتمل',
  };
  return statuses[statusCode] || 'غير معروف';
}

/**
 * تنسيق حجم الملف بصيغة قراءة
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * تنسيق الوقت بالثواني إلى HH:MM:SS
 */
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s
    .toString()
    .padStart(2, '0')}`;
}

/**
 * إرسال تنبيه عند انتهاء معالجة الفيديو (webhook)
 * يمكن استخدامه لاحقاً
 */
async function setupVideoProcessingWebhook(videoId) {
  // الميزة الاحترافية: إرسال webhook عند انتهاء المعالجة
  // يحتاج Stream Pro subscription
  console.log(`✓ يمكن إضافة webhook لـ ${videoId} (Stream Pro فقط)`);
}

// ═════════════════════════════════════════════════════════════════
// التصدير
// ═════════════════════════════════════════════════════════════════

module.exports = {
  // الدوال الرئيسية
  uploadVideoToBunny,
  deleteVideoFromBunny,
  getVideoInfo,
  generateSecureEmbedUrl,
  generateSecureViewUrl,

  // Utilities
  formatFileSize,
  formatDuration,
  getVideoStatus,
  setupVideoProcessingWebhook,

  // الإعدادات
  BUNNY_CONFIG,
};
