/**
 * صفحة رفع الفيديوهات للـ Admin
 * تصميم احترافي مثل Udemy
 */

import React, { useState, useRef } from 'react';
import { AlertCircle, Upload, Loader, CheckCircle } from 'lucide-react';
import axios from 'axios';

export default function VideoUploadPage({ courseId, lessons = [] }) {
  const [selectedLesson, setSelectedLesson] = useState(0);
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState(null); // 'success', 'error', null
  const [message, setMessage] = useState('');
  const fileInputRef = useRef(null);

  // ───────────────────────────────────────
  // معالجة اختيار الملف
  // ───────────────────────────────────────
  const handleFileChange = (e) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    // التحقق من نوع الملف
    const validTypes = ['video/mp4', 'video/mpeg', 'video/quicktime', 'video/x-msvideo'];
    if (!validTypes.includes(selectedFile.type)) {
      setStatus('error');
      setMessage('❌ الرجاء اختيار ملف فيديو (MP4, MOV, AVI)');
      return;
    }

    // التحقق من الحجم (أقصى 5GB)
    const maxSize = 5 * 1024 * 1024 * 1024; // 5GB
    if (selectedFile.size > maxSize) {
      setStatus('error');
      setMessage(`❌ حجم الملف كبير جداً (أقصى 5GB، حجمك: ${(selectedFile.size / 1024 / 1024 / 1024).toFixed(2)}GB)`);
      return;
    }

    setFile(selectedFile);
    setStatus(null);
    setMessage('✓ تم اختيار الملف');
  };

  // ───────────────────────────────────────
  // رفع الفيديو
  // ───────────────────────────────────────
  const handleUpload = async () => {
    if (!file) {
      setStatus('error');
      setMessage('❌ الرجاء اختيار ملف فيديو');
      return;
    }

    if (!courseId || selectedLesson === null) {
      setStatus('error');
      setMessage('❌ الرجاء اختيار الكورس والدرس');
      return;
    }

    setUploading(true);
    setProgress(0);
    setStatus(null);

    try {
      const formData = new FormData();
      formData.append('video', file);

      // رفع مع تتبع التقدم
      const response = await axios.post(
        `/api/videos/bunny-upload/${courseId}/${selectedLesson}`,
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data',
          },
          onUploadProgress: (progressEvent) => {
            const percentCompleted = Math.round(
              (progressEvent.loaded * 100) / progressEvent.total
            );
            setProgress(percentCompleted);
          },
        }
      );

      // نجح!
      setStatus('success');
      setMessage(`✅ ${response.data.message}`);
      setFile(null);
      setProgress(0);

      // عرض البيانات
      console.log('📊 معلومات الفيديو:', response.data.video);

      // إعادة تحميل الصفحة بعد 2 ثانية
      setTimeout(() => {
        window.location.reload();
      }, 2000);
    } catch (err) {
      setUploading(false);
      setStatus('error');
      const errorMsg = err.response?.data?.error || err.message;
      setMessage(`❌ خطأ: ${errorMsg}`);
      console.error('الخطأ:', err);
    }
  };

  // ───────────────────────────────────────
  // UI Components
  // ───────────────────────────────────────

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-8">
      <div className="max-w-2xl mx-auto">
        {/* الرأس */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">📹 رفع الفيديوهات</h1>
          <p className="text-gray-600">نظام احترافي مثل Udemy مع Bunny CDN</p>
        </div>

        {/* الكارد الرئيسي */}
        <div className="bg-white rounded-lg shadow-xl p-8">
          {/* اختيار الدرس */}
          <div className="mb-8">
            <label className="block text-lg font-semibold text-gray-900 mb-3">
              📚 اختر الدرس
            </label>
            {lessons.length > 0 ? (
              <select
                value={selectedLesson}
                onChange={(e) => setSelectedLesson(parseInt(e.target.value))}
                className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none"
              >
                {lessons.map((lesson, idx) => (
                  <option key={idx} value={idx}>
                    الدرس {idx + 1}: {lesson.title}
                  </option>
                ))}
              </select>
            ) : (
              <div className="text-red-600">❌ لا توجد دروس في هذا الكورس</div>
            )}
          </div>

          {/* منطقة التحميل */}
          <div className="mb-8">
            <label className="block text-lg font-semibold text-gray-900 mb-3">
              🎥 اختر ملف الفيديو
            </label>

            <div
              className={`border-4 border-dashed rounded-lg p-8 text-center transition-all ${
                file
                  ? 'border-green-500 bg-green-50'
                  : 'border-gray-300 bg-gray-50 hover:border-blue-500'
              }`}
              onClick={() => fileInputRef.current?.click()}
              style={{ cursor: 'pointer' }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                onChange={handleFileChange}
                className="hidden"
              />

              {!file ? (
                <div>
                  <Upload className="w-16 h-16 text-gray-400 mx-auto mb-4" />
                  <p className="text-xl font-semibold text-gray-700 mb-2">اسحب الملف هنا أو اضغط لاختيار</p>
                  <p className="text-gray-500 text-sm">
                    MP4, MOV, AVI... حتى 5GB
                  </p>
                </div>
              ) : (
                <div>
                  <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />
                  <p className="text-lg font-semibold text-green-700 mb-1">{file.name}</p>
                  <p className="text-gray-600 text-sm">
                    {(file.size / 1024 / 1024 / 1024).toFixed(2)} GB
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* شريط التقدم */}
          {uploading && (
            <div className="mb-8">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-gray-700">قيد الرفع...</span>
                <span className="text-sm font-bold text-blue-600">{progress}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
                <div
                  className="bg-gradient-to-r from-blue-500 to-blue-600 h-full transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {/* رسائل الحالة */}
          {status === 'success' && (
            <div className="mb-8 p-4 bg-green-50 border-l-4 border-green-500 rounded">
              <div className="flex items-start">
                <CheckCircle className="w-6 h-6 text-green-500 mt-0.5 ml-3 flex-shrink-0" />
                <div>
                  <p className="font-semibold text-green-800">{message}</p>
                  <p className="text-sm text-green-700 mt-1">
                    ✓ الفيديو محمي من التنزيل<br/>
                    ✓ جودة عالية adaptive streaming<br/>
                    ✓ سريع جداً بـ 250 خادم حول العالم
                  </p>
                </div>
              </div>
            </div>
          )}

          {status === 'error' && (
            <div className="mb-8 p-4 bg-red-50 border-l-4 border-red-500 rounded">
              <div className="flex items-start">
                <AlertCircle className="w-6 h-6 text-red-500 mt-0.5 ml-3 flex-shrink-0" />
                <p className="text-red-800">{message}</p>
              </div>
            </div>
          )}

          {status === null && message && (
            <div className="mb-8 p-4 bg-blue-50 border-l-4 border-blue-500 rounded">
              <p className="text-blue-800">{message}</p>
            </div>
          )}

          {/* الأزرار */}
          <div className="flex gap-4">
            <button
              onClick={handleUpload}
              disabled={!file || uploading}
              className={`flex-1 py-3 px-6 rounded-lg font-bold text-white transition-all flex items-center justify-center gap-2 ${
                !file || uploading
                  ? 'bg-gray-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-700 active:scale-95'
              }`}
            >
              {uploading ? (
                <>
                  <Loader className="w-5 h-5 animate-spin" />
                  جاري الرفع...
                </>
              ) : (
                <>
                  <Upload className="w-5 h-5" />
                  رفع الفيديو
                </>
              )}
            </button>

            <button
              onClick={() => {
                setFile(null);
                setProgress(0);
                setStatus(null);
              }}
              disabled={uploading}
              className="py-3 px-6 rounded-lg font-bold border-2 border-gray-300 text-gray-700 hover:bg-gray-50 transition-all"
            >
              إلغاء
            </button>
          </div>

          {/* معلومات مفيدة */}
          <div className="mt-8 pt-8 border-t-2 border-gray-200">
            <h3 className="font-bold text-gray-900 mb-4">💡 معلومات مهمة:</h3>
            <ul className="space-y-2 text-sm text-gray-700">
              <li>✓ <strong>محمي من التنزيل:</strong> الطالب لا يمكنه تنزيل الفيديو</li>
              <li>✓ <strong>جودة تلقائية:</strong> تتكيف مع سرعة الإنترنت (360p إلى 1080p)</li>
              <li>✓ <strong>سريع جداً:</strong> 250 خادم موزعة حول العالم (CDN)</li>
              <li>✓ <strong>آمن:</strong> بيانات مشفرة وموثوقة 99.9% uptime</li>
              <li>✓ <strong>رخيص:</strong> 0.01$ لكل GB فقط!</li>
              <li>⚠️ <strong>وقت المعالجة:</strong> قد يستغرق 5-30 دقيقة حسب الحجم</li>
            </ul>
          </div>
        </div>

        {/* شرح النظام */}
        <div className="mt-8 bg-blue-50 border-l-4 border-blue-500 rounded-lg p-6">
          <h3 className="font-bold text-blue-900 mb-3">🚀 كيف يعمل النظام؟</h3>
          <ol className="space-y-2 text-sm text-blue-800">
            <li>1. اختر الدرس من القائمة</li>
            <li>2. أضفِ ملف الفيديو (أي حجم، حتى 5GB)</li>
            <li>3. اضغط "رفع الفيديو"</li>
            <li>4. استرخ... Bunny يتولى المعالجة!</li>
            <li>5. الطالب يشاهد الفيديو بجودة عالية وآمنة</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
