const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const bcrypt = require('bcryptjs');
const { getDb, initDatabase } = require('../lib/sqlite');
const defaultCourses = require('../data/default-courses.json'); // Assuming the file is renamed to .json

async function seedDatabase() {
  try {
    initDatabase();
    const db = getDb();
    
    // التأكد من وجود عمود lesson_order
    const columns = db.pragma('table_info(lessons)', { simple: true }).map(col => col.name);
    if (!columns.includes("lesson_order")) {
      db.exec("ALTER TABLE lessons ADD COLUMN lesson_order INTEGER;");
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `);

    const { courseCount } = db.prepare('SELECT COUNT(*) as courseCount FROM courses').get();
    const { userCount } = db.prepare('SELECT COUNT(*) as userCount FROM users').get();
    const { categoryCount } = db.prepare('SELECT COUNT(*) as categoryCount FROM categories').get();

    if (courseCount > 0 && userCount > 0 && categoryCount > 0) {
      console.log(`Database seed skipped. Found ${courseCount} courses, ${userCount} users, and ${categoryCount} categories.`);
      return;
    }

    console.log('🌱 Starting to seed database...');

    const seedTransaction = db.transaction(() => {
      // 1. إضافة المدير (Admin)
      if (userCount === 0) {
        console.log('Creating default admin user...');
        const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123!';
        const passwordHash = bcrypt.hashSync(adminPassword, 12);
        const timestamp = new Date().toISOString();

        db.prepare(`
          INSERT INTO users (first_name, last_name, username, email, password_hash, role, is_verified, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'admin', 1, ?, ?)
        `).run(
          'مدير',
          'النظام',
          process.env.ADMIN_USERNAME || 'admin1',
          process.env.ADMIN_EMAIL || 'admin@hifz.local',
          passwordHash,
          timestamp,
          timestamp
        );
        console.log('✅ Default admin user created.');
        console.log(`   Username: ${process.env.ADMIN_USERNAME || 'admin1'}`);
        console.log(`   Password: ${adminPassword}`);
      }

      // 2. إضافة التصنيفات الافتراضية
      if (categoryCount === 0) {
        console.log('Seeding default categories...');
        const categories = [
            { name: 'حفظ القرآن', slug: 'quran-memorization' },
            { name: 'التجويد', slug: 'tajweed' },
            { name: 'السنة', slug: 'sunnah' },
            { name: 'الفقه', slug: 'fiqh' },
            { name: 'العقيدة', slug: 'aqidah' },
        ];
        const insertCat = db.prepare('INSERT INTO categories (name, slug, created_at) VALUES (?, ?, ?)');
        const timestamp = new Date().toISOString();
        categories.forEach(cat => {
            insertCat.run(cat.name, cat.slug, timestamp);
        });
        console.log('✅ Default categories created.');
      }

      // 3. إضافة الكورسات الافتراضية
      if (courseCount > 0) {
        console.log('Skipping course seeding as courses already exist.');
      } else {
        console.log('Seeding default courses...');
        const insertCourse = db.prepare(`
          INSERT INTO courses (
            id, title, category, emoji, bg, badge, level, price, old_price, 
            duration_label, students_count, rating, description, includes_json, 
            thumbnail, is_published, created_at, updated_at
          ) VALUES (
            @id, @title, @category, @emoji, @bg, @badge, @level, @price, @old_price,
            @duration_label, @students_count, @rating, @description, @includes_json,
            @thumbnail, @is_published, @created_at, @updated_at
          )
        `);

        const insertLesson = db.prepare(`
          INSERT INTO lessons (
            course_id, title, description, duration_label, is_free, lesson_order
          ) VALUES (
            @course_id, @title, @description, @duration_label, @is_free, @lesson_order
          )
        `);
        for (const courseData of defaultCourses) {
          const courseId = Number(courseData.id || courseData.legacyId);
          insertCourse.run({
            id: courseId,
            title: courseData.title,
            category: courseData.category || 'حفظ القرآن',
            emoji: courseData.emoji || '📖',
            bg: courseData.bg || 'linear-gradient(135deg,#1a6b4a,#22865e)',
            badge: courseData.badge || '',
            level: courseData.level || 'مبتدئ',
            price: Number(courseData.price || 0),
            old_price: Number(courseData.oldPrice || 0),
            duration_label: courseData.durationLabel || courseData.duration || '',
            students_count: Number(courseData.studentsCount || courseData.students || 0),
            rating: Number(courseData.rating || 5),
            description: courseData.description || courseData.desc || '',
            includes_json: JSON.stringify(Array.isArray(courseData.includes) ? courseData.includes.filter(Boolean) : []),
            thumbnail: courseData.thumbnail || courseData.imgData || '',
            is_published: courseData.isPublished !== false ? 1 : 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });

          (courseData.lessons || []).forEach((lesson, index) => {
            insertLesson.run({
              course_id: courseId,
              title: lesson.title || '',
              description: lesson.description || '',
              duration_label: lesson.durationLabel || lesson.duration || '',
              is_free: Boolean(lesson.isFree ?? lesson.free) ? 1 : 0,
              lesson_order: index + 1,
            });
          });
          console.log(`Seeded course: ${courseData.title}`);
        }
      }
    });

    seedTransaction();
    console.log('🏁 Database seed complete.');
  } catch (error) {
    console.error('❌ Seed failed:', error.message);
    // لا نغلق الاتصال هنا، لأن التطبيق الرئيسي قد يحتاجه
  }
}

// لا تقم بتشغيل الدالة تلقائياً عند استيراد الملف
// سيتم تشغيلها فقط عند الحاجة من خلال أمر npm
if (require.main === module) {
  seedDatabase().finally(() => getDb()?.close());
}

module.exports = { seedDatabase };
