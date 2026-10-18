// Exploratory occupational-interest self-report (RIASEC-style, 6 constructs x 6 items).
//
// ORIGINAL wording written for this prototype. It is NOT the O*NET Interest Profiler,
// is not licensed from any third party, and has no validation evidence (spec §4.1, §4.4).
// Use is limited to the synthetic prototype. Do not describe results as a validated Holland Code.
const L = (ar, en) => ({ 'ar-SA': ar, en });

const item = (construct, n, ar, en) => ({
  item_id: `INT-${construct}-${String(n).padStart(3, '0')}`,
  construct: `RIASEC_${construct}`,
  content: L(ar, en),
  response_type: 'likert_5',
  scale: 'interest_like',
  reverse_coded: false,
  status: 'draft_exploratory_only',
});

export const RIASEC_DIMENSIONS = ['R', 'I', 'A', 'S', 'E', 'C'];

export const RIASEC_META = {
  R: { name: L('الواقعي (العملي)', 'Realistic (hands-on)'), blurb: L('العمل بالأدوات والآلات والمشاريع الملموسة.', 'Working with tools, machines and tangible projects.') },
  I: { name: L('البحثي (الاستقصائي)', 'Investigative'), blurb: L('التحليل والتجريب وفهم كيف ولماذا تعمل الأشياء.', 'Analysing, experimenting and working out how and why things work.') },
  A: { name: L('الفني (الإبداعي)', 'Artistic'), blurb: L('التعبير الإبداعي والتصميم وابتكار الأفكار الأصلية.', 'Creative expression, design and original ideas.') },
  S: { name: L('الاجتماعي', 'Social'), blurb: L('مساعدة الآخرين وتعليمهم ودعمهم.', 'Helping, teaching and supporting other people.') },
  E: { name: L('المبادر (الريادي)', 'Enterprising'), blurb: L('القيادة والإقناع وبدء المشاريع وتحمّل المبادرة.', 'Leading, persuading and starting things.') },
  C: { name: L('التنظيمي (التقليدي)', 'Conventional'), blurb: L('التنظيم والدقة والعمل وفق إجراءات واضحة.', 'Organising, accuracy and following clear procedures.') },
};

export const interestExploratory = {
  instrument_id: 'interest_exploratory',
  name: L('استكشاف الميول المهنية (تجريبي)', 'Interest Explorer (exploratory)'),
  purpose: L(
    'يساعدك على ملاحظة الأنشطة التي تميل إليها. لا توجد إجابات صحيحة أو خاطئة.',
    'Helps you notice which kinds of activities you are drawn to. There are no right or wrong answers.',
  ),
  stem: L('ما مدى حبّك لكل نشاط من الأنشطة التالية؟', 'How much would you like each of these activities?'),
  construct: 'RIASEC interests (self-report preferences)',
  version: '0.1.0',
  locale_set: ['ar-SA', 'en'],
  usage_class: 'exploratory_synthetic_only',
  scoring: { type: 'riasec_mean', version: 'riasec-exploratory-mean-1.0.0', min_answered_per_construct: 4 },
  items: [
    item('R', 1, 'استخدام الأدوات لحل مشكلات عملية.', 'Using tools to solve practical problems.'),
    item('R', 2, 'إصلاح جهاز أو تركيب قطعة من المعدات.', 'Repairing a device or assembling a piece of equipment.'),
    item('R', 3, 'العمل في الهواء الطلق على مشروع عملي مثل البناء أو الزراعة.', 'Working outdoors on a hands-on project such as building or gardening.'),
    item('R', 4, 'معرفة كيف تعمل الآلات أو المحركات بتفكيكها.', 'Finding out how machines or engines work by taking them apart.'),
    item('R', 5, 'صنع شيء ملموس من مواد أولية.', 'Making something physical from raw materials.'),
    item('R', 6, 'تشغيل مركبة أو معدة بمهارة وأمان.', 'Operating a vehicle or equipment skilfully and safely.'),

    item('I', 1, 'اكتشاف كيف يعمل شيء ما ولماذا.', 'Figuring out how and why something works.'),
    item('I', 2, 'إجراء تجربة لاختبار فكرة.', 'Running an experiment to test an idea.'),
    item('I', 3, 'تحليل البيانات للبحث عن أنماط.', 'Analysing data to look for patterns.'),
    item('I', 4, 'قراءة أخبار الاكتشافات العلمية.', 'Reading about scientific discoveries.'),
    item('I', 5, 'حل لغز صعب في الرياضيات أو المنطق.', 'Solving a difficult maths or logic puzzle.'),
    item('I', 6, 'البحث في سؤال حتى أصل إلى إجابة مدعومة بالأدلة.', 'Researching a question until I find a well-supported answer.'),

    item('A', 1, 'تصميم ملصقات أو شعارات أو صور رقمية.', 'Designing posters, logos or digital images.'),
    item('A', 2, 'كتابة قصص أو قصائد أو مقالات.', 'Writing stories, poems or articles.'),
    item('A', 3, 'العزف أو تأليف الموسيقى.', 'Playing or composing music.'),
    item('A', 4, 'التمثيل أو التقديم على المسرح أو أمام الكاميرا.', 'Acting or presenting on a stage or in front of a camera.'),
    item('A', 5, 'ابتكار أفكار أصلية لشكل شيء ما.', 'Coming up with original ideas for how something could look.'),
    item('A', 6, 'التصوير وتحرير الصور أو مقاطع الفيديو.', 'Taking and editing photographs or videos.'),

    item('S', 1, 'مساعدة زميل على فهم شيء يجده صعبًا.', 'Helping a classmate understand something they find difficult.'),
    item('S', 2, 'تعليم أو تدريب طلاب أصغر سنًا.', 'Teaching or coaching younger students.'),
    item('S', 3, 'الاستماع إلى الناس ودعمهم في مواجهة مشكلة.', 'Listening to people and supporting them through a problem.'),
    item('S', 4, 'التطوع من أجل قضية مجتمعية.', 'Volunteering for a community cause.'),
    item('S', 5, 'رعاية المرضى أو من يحتاجون إلى مساعدة.', 'Caring for people who are unwell or need assistance.'),
    item('S', 6, 'استقبال الزوار أو الطلاب الجدد وإرشادهم.', 'Welcoming and guiding visitors or new students.'),

    item('E', 1, 'قيادة مجموعة لتحقيق هدف مشترك.', 'Leading a group towards a shared goal.'),
    item('E', 2, 'بدء مشروع صغير أو عمل تجاري خاص بي.', 'Starting a small project or business of my own.'),
    item('E', 3, 'إقناع الآخرين بدعم فكرتي.', 'Persuading others to back my idea.'),
    item('E', 4, 'التفاوض أو إبرام صفقة.', 'Negotiating or making a deal.'),
    item('E', 5, 'تحمّل مسؤولية قرارات تنطوي على قدر من المخاطرة.', 'Taking responsibility for decisions that involve some risk.'),
    item('E', 6, 'التحدث أمام جمهور لتحفيزه.', 'Speaking in front of an audience to motivate them.'),

    item('C', 1, 'الحفاظ على السجلات والملفات منظمة ودقيقة.', 'Keeping records and files organised and accurate.'),
    item('C', 2, 'مراجعة الأرقام أو التفاصيل بعناية للتأكد من خلوها من الأخطاء.', 'Checking numbers or details carefully for mistakes.'),
    item('C', 3, 'اتباع إجراءات واضحة خطوة بخطوة.', 'Following clear step-by-step procedures.'),
    item('C', 4, 'إعداد ميزانية أو تتبع المصروفات.', 'Preparing a budget or tracking expenses.'),
    item('C', 5, 'وضع جدول زمني والالتزام به.', 'Planning a schedule and sticking to it.'),
    item('C', 6, 'إدخال المعلومات وتنظيمها في جداول بيانات أو قواعد بيانات.', 'Entering and organising information in spreadsheets or databases.'),
  ],
};
