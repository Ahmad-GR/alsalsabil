/**
 * مكون عرض الفيديو الآمن (Bunny Player)
 * مثل Udemy تماماً
 */

import React, { useState, useEffect } from 'react';
import { AlertCircle, Loader, Volume2, RotateCcw } from 'lucide-react';
import axios from 'axios';

export default function SecureVideoPlayer({ courseId, lessonIndex, lessonTitle }) {
  const [videoUrl, setVideoUrl] = useState(null);
  const [embedUrl, setEmbedUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [videoInfo, setVideoInfo] = useState(null);

  // ───────────────────────────────────────
  // تحميل الفيديو عند التحميل
  // ───────────────────────────────────────
  useEffect(() => {
    fetchVideoUrl();
  }, [courseId, lessonIndex]);

  const fetchVideoUrl = async () => {
    try {
      setLoading(true);
      setError(null);

      // طلب الفيديو من الـ Backend (مع التحقق من الوصول)
      const response = await axios.get(`/api/videos/bunny/${courseId}/${lessonIndex}`);

      if (response.data.success) {
        setVideoInfo(response.data.video);
        setEmbedUrl(response.data.video.embedUrl);
        setVideoUrl(response.data.video.embedUrl);
      } else {
        setError(response.data.error);
      }
    } catch (err) {
      const errorMsg = err.response?.data?.error || err.message;
      setError(errorMsg);

      // معالجة خاصة للأخطاء الشائعة
      if (err.response?.status === 403) {
        setError('❌ يجب الاشتراك في الكورس للوصول لهذا الدرس');
      }
    } finally {
      setLoading(false);
    }
  };

  // ───────────────────────────────────────
  // حالات مختلفة
  // ───────────────────────────────────────

  if (loading) {
    return (
      <div className="w-full aspect-video bg-gray-900 rounded-lg flex items-center justify-center">
        <div className="text-center">
          <Loader className="w-12 h-12 text-white animate-spin mx-auto mb-4" />
          <p className="text-white font-semibold">جاري تحميل الفيديو...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full aspect-video bg-red-50 rounded-lg border-2 border-red-300 flex items-center justify-center">
        <div className="text-center max-w-md mx-auto p-6">
          <AlertCircle className="w-12 h-12 text-red-600 mx-auto mb-4" />
          <p className="text-red-800 font-bold text-lg mb-2">{error}</p>
          <button
            onClick={fetchVideoUrl}
            className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 font-semibold flex items-center gap-2 mx-auto"
          >
            <RotateCcw className="w-4 h-4" />
            محاولة مرة أخرى
          </button>
        </div>
      </div>
    );
  }

  if (!embedUrl) {
    return (
      <div className="w-full aspect-video bg-gray-200 rounded-lg border-2 border-gray-300 flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="w-12 h-12 text-gray-500 mx-auto mb-4" />
          <p className="text-gray-700 font-semibold">لم يتم رفع فيديو لهذا الدرس بعد</p>
        </div>
      </div>
    );
  }

  // ───────────────────────────────────────
  // عرض الفيديو
  // ───────────────────────────────────────

  return (
    <div className="w-full space-y-4">
      {/* الفيديو نفسه */}
      <div className="relative w-full bg-black rounded-lg overflow-hidden shadow-xl">
        <iframe
          src={embedUrl}
          loading="lazy"
          title={lessonTitle}
          allow="accelerometer;gyroscope;autoplay;encrypted-media;picture-in-picture"
          allowFullScreen
          className="w-full aspect-video"
          style={{
            border: 'none',
            borderRadius: '8px',
          }}
        />
      </div>

      {/* البيانات والمعلومات */}
      {videoInfo && (
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-6 border border-blue-200">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">{videoInfo.title}</h2>

          {/* معلومات الفيديو */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-white rounded-lg p-4 border border-blue-200">
              <p className="text-gray-600 text-sm">المدة</p>
              <p className="text-lg font-bold text-blue-600">{videoInfo.duration}</p>
            </div>
            <div className="bg-white rounded-lg p-4 border border-blue-200">
              <p className="text-gray-600 text-sm">الحجم</p>
              <p className="text-lg font-bold text-blue-600">{videoInfo.fileSize}</p>
            </div>
            <div className="bg-white rounded-lg p-4 border border-blue-200">
              <p className="text-gray-600 text-sm">الجودة</p>
              <p className="text-lg font-bold text-blue-600">1080p</p>
            </div>
            <div className="bg-white rounded-lg p-4 border border-blue-200">
              <p className="text-gray-600 text-sm">CDN سرعة</p>
              <p className="text-lg font-bold text-blue-600">250 خادم</p>
            </div>
          </div>

          {/* الميزات */}
          <div>
            <h3 className="font-bold text-gray-900 mb-3">✨ الميزات:</h3>
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <li className="flex items-center gap-2 text-green-700">
                <span className="text-green-600 font-bold">✓</span>
                محمي من التنزيل
              </li>
              <li className="flex items-center gap-2 text-green-700">
                <span className="text-green-600 font-bold">✓</span>
                جودة تلقائية حسب السرعة
              </li>
              <li className="flex items-center gap-2 text-green-700">
                <span className="text-green-600 font-bold">✓</span>
                توقف واستئناف آمن
              </li>
              <li className="flex items-center gap-2 text-green-700">
                <span className="text-green-600 font-bold">✓</span>
                315 دول حول العالم
              </li>
              <li className="flex items-center gap-2 text-green-700">
                <span className="text-green-600 font-bold">✓</span>
                عدم تسريب الملكية الفكرية
              </li>
              <li className="flex items-center gap-2 text-green-700">
                <span className="text-green-600 font-bold">✓</span>
                مشاهدة بدون انقطاع
              </li>
            </ul>
          </div>

          {/* نصيحة */}
          <div className="mt-6 p-4 bg-blue-100 rounded-lg border-l-4 border-blue-600">
            <p className="text-blue-800 text-sm">
              <strong>💡 نصيحة:</strong> لأفضل جودة، استخدم متصفح حديث (Chrome, Firefox, Safari).
              الفيديو يتكيف تلقائياً مع سرعة اتصالك
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════
// مثال الاستخدام في صفحة الكورس:
// ═════════════════════════════════════════════════════════════════
/*

import SecureVideoPlayer from '@/components/SecureVideoPlayer';

export default function CourseLessonPage({ courseId, lessonIndex, lesson }) {
  return (
    <div className="max-w-4xl mx-auto p-8">
      <SecureVideoPlayer 
        courseId={courseId}
        lessonIndex={lessonIndex}
        lessonTitle={lesson.title}
      />
      
      {/* محتوى إضافي *//*}
      <div className="mt-8">
        <h2 className="text-2xl font-bold mb-4">ملخص الدرس</h2>
        <p>{lesson.description}</p>
        
        {/* أزرار إضافية *//*}
        <div className="flex gap-4 mt-6">
          <button className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            ⬇️ حمّل الملاحظات (PDF)
          </button>
          <button className="px-6 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700">
            💬 اطرح سؤال
          </button>
        </div>
      </div>
    </div>
  );
}

*/
