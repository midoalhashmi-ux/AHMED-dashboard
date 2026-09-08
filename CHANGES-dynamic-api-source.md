# إضافة مصدر API ديناميكي

- أضيف نوع المصدر `API ديناميكي / Encoded API` إلى بطاقة القناة.
- يُحفظ رابط API المستقر فقط في `channels.sourceUrl`.
- لا تُكتب روابط `m3u8` المؤقتة إلى Firestore، ويمنع النموذج حفظ رابط
  فيديو مباشر عند اختيار نوع API.
- يمكن ضبط Referer وUser-Agent لطلب API بشكل مستقل عن Headers التشغيل
  للرابط النهائي.
- الحقول القديمة `streamType=web` و`streamType=hls` و`directUrl` و
  `privateStreams` ما زالت مدعومة كما هي.