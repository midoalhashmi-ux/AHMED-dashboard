# تقرير تعديلات UX — CLOUDAPP2026SHEIKH + AHMED-dashboard

## الفحص الأولي
- تم فحص بنية المشروعين قبل التعديل.
- تطبيق المحتوى Flutter يستخدم `HomeShell` مع `IndexedStack` وFirestore عبر `ContentService`.
- اتجاه التطبيق عربي (`Locale('ar')`) مع delegates عربية.
- القنوات الحالية محفوظة في مجموعة `channels`، والأقسام في `categories`.
- فتح المشغل يمر عبر `PlayerLauncher.openChannel(context, channelId)` ولم يتم تعديل هذه الآلية.
- روابط البث المحمية تبقى في `privateStreams` ولا تُنقل إلى تطبيق المحتوى.
- لوحة التحكم تستخدم Firebase Auth + Firestore Web SDK، مع `merge: true` لإعدادات `settings/player` و`settings/app` وغيرها.

## CLOUDAPP2026SHEIKH
- استبدال شريط التنقل الرئيسي بتصميم ثلاثي ثابت فيزيائياً:
  - يمين: القنوات
  - وسط: النتائج
  - يسار: أفلام ومسلسلات
- استخدام `Directionality.ltr` فقط لتثبيت المواقع الفيزيائية للتبويبات، مع RTL داخل كل زر.
- إضافة تبويب أفلام ومسلسلات مستقل مع:
  - بطاقات أغلفة.
  - النوع، السنة، Premium، مميز.
  - فلاتر الكل/أفلام/مسلسلات/أنمي.
  - بحث بالاسم.
  - skeleton loading وempty/error states.
  - قسم محتوى مميز عند توفره.
- إضافة حقول محتوى اختيارية backward-compatible إلى `ChannelModel`.
- إضافة `contentType` مع fallback تلقائي إلى `channel` للسجلات القديمة.
- إضافة `watchMediaContents()` مع تصفية movie/series/anime من مجموعة `channels` الحالية، بدون إنشاء بنية Firestore جديدة.
- استبدال الاعتماد على Drawer الافتراضي بقائمة مخصصة مثبتة فعلياً على `left: 0` مع حركة 300ms، خلفية شفافة، إغلاق بالضغط خارجها/السحب، ودعم Back.
- وظائف عناصر القائمة الحالية بقيت كما هي.

## AHMED-dashboard
- إضافة بطاقات تصنيفات احترافية: قنوات، أفلام، مسلسلات، أنمي، نتائج، محتوى مميز.
- إضافة مكتبة محتوى قابلة للتصفية مع العدد والنوع والحالة وأزرار تعديل/حذف.
- إضافة أزرار إضافة المحتوى وإضافة النوع المحدد.
- توسيع نموذج المحتوى الحالي فقط، دون إنشاء نظام CRUD منفصل:
  - `contentType`
  - `posterUrl`
  - `releaseYear`
  - `genre`
  - `isFeatured`
  - `isPremium`
  - وحقول الموسم/الحلقة الاختيارية.
- القنوات القديمة بدون `contentType` تعامل كـ `channel`.
- إنشاء المحتوى الجديد يحفظ `contentType` افتراضياً.
- تحديثات إعدادات player/app بقيت باستخدام Firestore merge.
- لم يتم تعديل Worker أو Firestore Rules أو Deep Links أو privateStreams.

## الاختبارات
- `node --check app.js`: ناجح.
- `node --check index.js`: ناجح.
- HTML parsing: ناجح.
- فحص توازن الأقواس/الأقواس البرمجية للملفات Dart المعدلة: ناجح بعد تصحيح نموذج البيانات.
- `flutter analyze` / `dart analyze` / `flutter test`: لم يمكن تشغيلها لأن Flutter/Dart غير مثبتين في بيئة التنفيذ الحالية.
- اختبار Android فعلي واتجاه حركة Drawer يحتاج جهاز/محاكي Android، لذلك تم تثبيت الاتجاه برمجياً عبر `Positioned(left: ...)` وAnimation صريحة، لكن لا يمكن الادعاء بأنه اختبار جهاز فعلي من هذه البيئة.

## الملفات المعدلة
### التطبيق
- `lib/core/models/channel_model.dart`
- `lib/core/services/content_service.dart`
- `lib/features/home/home_shell.dart`
- `lib/widgets/app_drawer.dart`
- `lib/features/media/media_home_tab.dart` (جديد)

### لوحة التحكم
- `index.html`
- `styles.css`
- `app.js`

## الملفات الحساسة
لم يتم تعديل:
- `cloudflare-worker/src/index.js`
- `firestore.rules`
- `lib/core/services/player_launcher.dart`
- `lib/core/services/secure_stream_service.dart`

وبالتالي لم يتم تغيير منطق Worker أو حماية روابط البث أو Deep Link الحالي.
