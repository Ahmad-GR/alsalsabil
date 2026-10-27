const express    = require('express');
const multer     = require('multer');
const { protect, isAdmin } = require('../middleware/auth');
const {
  uploadVideoToBunny,
  deleteVideoFromBunny,
  getVideoInfo,
  generateSecureEmbedUrl,
  formatFileSize,
  formatDuration
} = require('../utils/bunny');
const { getDb, nowIso, runInTransaction } = require('../lib/postgres');
const {
  getSerializedCourseById,
  getCourseRowById
} = require('./site');

const router  = express.Router();
const storage = multer.memoryStorage();
const upload  = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 * 1024 } }); // 5GB للـ Bunny

// ═════════════════════════════════════════════════════════════════
// 🚀 BUNNY CDN - نظام الفيديوهات الاحترافي (مثل Udemy)
// ═════════════════════════════════════════════════════════════════

/**
 * POST /api/videos/bunny-upload/:courseId/:lessonIndex
 * رفع فيديو إلى Bunny CDN
 * ✓ يدعم ملفات كبيرة (5GB)
 * ✓ محمي من التنزيل
 * ✓ جودة عالية adaptive streaming
 * ✓ سريع جداً (250 خادم حول العالم)
 */
router.post('/bunny-upload/:courseId/:lessonIndex', protect, isAdmin, upload.single('video'), async (req, res) => {
  try {
    const { courseId, lessonIndex } = req.params;

    // 1️⃣ التحقق من الملف
    if (!req.file) {
      return res.status(400).json({ error: 'لم يتم اختيار ملف فيديو' });
    }

    // 2️⃣ التحقق من الكورس
    const course = getCourseRowById(courseId);
    if (!course) {
      return res.status(404).json({ error: 'الكورس غير موجود' });
    }

    // 3️⃣ التحقق من الدرس
    const db = getDb();
    const lessons = db.prepare('SELECT * FROM lessons WHERE course_id = ? ORDER BY lesson_order ASC, id ASC').all(courseId);
    const lessonIdx = parseInt(lessonIndex);
    if (lessonIdx < 0 || lessonIdx >= lessons.length) {
      return res.status(404).json({ error: 'الدرس غير موجود' });
    }
    const lesson = lessons[lessonIdx];

    // 4️⃣ حذف الفيديو القديم إذا كان موجود
    if (lesson.bunny_video_id) {
      try {
        await deleteVideoFromBunny(lesson.bunny_video_id);
        console.log(`✓ تم حذف الفيديو القديم: ${lesson.bunny_video_id}`);
      } catch (err) {
        console.warn(`⚠️  لم يتمكن من حذف الفيديو القديم:`, err.message);
      }
    }

    // 5️⃣ رفع الفيديو الجديد إلى Bunny
    console.log(`📤 بدء رفع الفيديو: ${lesson.title}`);
    const videoInfo = await uploadVideoToBunny(
      req.file.buffer,
      lesson.title,
      courseId
    );

    // 6️⃣ تحديث الدرس في قاعدة البيانات
    db.prepare(`
      UPDATE lessons 
      SET 
        bunny_video_id = ?, 
        video_url = ?, 
        duration = ?, 
        file_size = ?, 
        is_protected = 1, 
        processing_status = ?, 
        uploaded_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      videoInfo.bunnyVideoId, videoInfo.embedUrl, videoInfo.duration,
      videoInfo.fileSize, videoInfo.status, nowIso(), nowIso(), lesson.id
    );

    console.log(`✅ تم رفع الفيديو بنجاح للدرس: "${lesson.title}"`);
    res.json({
      success: true,
      message: '✅ تم رفع الفيديو بنجاح!',
      video: {
        id: videoInfo.bunnyVideoId,
        title: videoInfo.title,
        duration: formatDuration(videoInfo.duration),
        fileSize: formatFileSize(videoInfo.fileSize),
        embedUrl: videoInfo.embedUrl,
        status: videoInfo.status,
        note: 'الفيديو محمي من التنزيل ويدعم adaptive streaming حسب سرعة النت',
      },
    });
  } catch (err) {
    console.error('❌ خطأ في رفع الفيديو:', err.message);
    res.status(500).json({
      error: `فشل رفع الفيديو. الخطأ: ${err.message}`,
      tip: 'تأكد من توفر BUNNY_API_KEY و BUNNY_STREAM_LIBRARY_ID في .env',
    });
  }
});

/**
 * GET /api/videos/bunny/:courseId/:lessonIndex
 * الحصول على رابط آمن لعرض الفيديو
 * ✓ تحقق من الاشتراك في الكورس
 * ✓ رابط آمن محمي
 * ✓ صلاحية محدودة (24 ساعة)
 */
router.get('/bunny/:courseId/:lessonIndex', protect, async (req, res) => {
  try {
    const { courseId, lessonIndex } = req.params;
    const userId = req.user.id;

    // 1️⃣ التحقق من الكورس
    const db = getDb();
    const course = getCourseRowById(courseId);
    if (!course) {
      return res.status(404).json({ error: 'الكورس غير موجود' });
    }

    // 2️⃣ التحقق من الدرس
    const lessons = db.prepare('SELECT * FROM lessons WHERE course_id = ? ORDER BY lesson_order ASC, id ASC').all(courseId);
    const lessonIdx = parseInt(lessonIndex);
    if (lessonIdx < 0 || lessonIdx >= lessons.length) {
      return res.status(404).json({ error: 'الدرس غير موجود' });
    }
    const lesson = lessons[lessonIdx];

    // 3️⃣ التحقق من وجود الفيديو
    if (!lesson.bunny_video_id) {
      return res.status(404).json({ error: 'لم يتم رفع فيديو لهذا الدرس بعد' });
    }

    // 4️⃣ التحقق من الوصول (إذا كان الدرس مدفوع)
    if (!lesson.is_free) {
      const enrollment = db.prepare('SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?')
        .get(userId, Number(courseId));

      if (!enrollment) {
        return res.status(403).json({
          error: 'يجب الاشتراك في الكورس للوصول لهذا الدرس',
          code: 'ENROLLMENT_REQUIRED',
        });
      }
    }

    // 5️⃣ إنشاء رابط آمن محمي
    const secureUrl = generateSecureEmbedUrl(lesson.bunny_video_id, 24);

    res.json({
      success: true,
      video: {
        id: lesson.bunny_video_id,
        title: lesson.title,
        embedUrl: lesson.video_url, // رابط الـ iframe العادي
        secureLinkUrl: secureUrl, // (للنسخة المتقدمة)
        duration: formatDuration(lesson.duration),
        fileSize: formatFileSize(lesson.file_size),
      },
      features: {
        protected: true,
        adaptiveStreaming: true,
        noDownload: true,
        offlineNotAvailable: true,
        qualityAuto: '360p, 480p, 720p, 1080p',
      },
    });
  } catch (err) {
    console.error('❌ خطأ:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/videos/bunny-info/:videoId
 * الحصول على معلومات الفيديو (الحالة، الجودات، إلخ)
 */
router.get('/bunny-info/:videoId', protect, isAdmin, async (req, res) => {
  try {
    const { videoId } = req.params;
    const info = await getVideoInfo(videoId);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/videos/bunny/:courseId/:lessonIndex
 * حذف الفيديو من Bunny
 */
router.delete('/bunny/:courseId/:lessonIndex', protect, isAdmin, async (req, res) => {
  try {
    const { courseId, lessonIndex } = req.params;
    // التحقق من الكورس
    const db = getDb();
    const course = getCourseRowById(courseId);
    if (!course) {
      return res.status(404).json({ error: 'الكورس غير موجود' });
    }

    const lessons = db.prepare('SELECT * FROM lessons WHERE course_id = ? ORDER BY lesson_order ASC, id ASC').all(courseId);
    const lessonIdx = parseInt(lessonIndex);
    if (lessonIdx < 0 || lessonIdx >= lessons.length || !lessons[lessonIdx].bunny_video_id) {
      return res.status(404).json({ error: 'لا يوجد فيديو لحذفه' });
    }

    // حذف من Bunny
    const videoId = lessons[lessonIdx].bunny_video_id;
    await deleteVideoFromBunny(videoId);

    // تحديث قاعدة البيانات
    db.prepare(`
      UPDATE lessons 
      SET bunny_video_id = NULL, video_url = NULL, duration = 0, file_size = 0, updated_at = ?
      WHERE id = ?
    `).run(nowIso(), lessons[lessonIdx].id);

    console.log(`✓ تم حذف الفيديو بنجاح من الدرس: "${lessons[lessonIdx].title}"`);

    res.json({ success: true, message: '✓ تم حذف الفيديو بنجاح' });
  } catch (err) {
    console.error('❌ خطأ:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
