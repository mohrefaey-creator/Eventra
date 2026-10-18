// Subject preferences, self-reported skills confidence, work values and student constraints.
// All are ORIGINAL, exploratory, unvalidated, and limited to the synthetic prototype.
const L = (ar, en) => ({ 'ar-SA': ar, en });

export const SUBJECTS = {
  math: L('الرياضيات', 'Mathematics'),
  physics: L('الفيزياء', 'Physics'),
  chemistry: L('الكيمياء', 'Chemistry'),
  biology: L('الأحياء', 'Biology'),
  computer: L('الحاسب والمهارات الرقمية', 'Computer science & digital skills'),
  english: L('اللغة الإنجليزية', 'English language'),
  arabic: L('اللغة العربية', 'Arabic language'),
  islamic: L('الدراسات الإسلامية', 'Islamic studies'),
  social: L('الدراسات الاجتماعية', 'Social studies'),
  business: L('الإدارة والاقتصاد', 'Business & economics'),
  art: L('التربية الفنية والتصميم', 'Art & design'),
  pe: L('التربية البدنية', 'Physical education'),
};

export const SKILLS = {
  analytical: [L('تقسيم مشكلة معقدة إلى خطوات أبسط.', 'Breaking a complex problem into simpler steps.')],
  numeracy: [L('العمل مع الأرقام والحسابات.', 'Working with numbers and calculations.')],
  communication: [L('شرح فكرة بوضوح بالكلام أو الكتابة.', 'Explaining an idea clearly, in speech or in writing.')],
  creativity: [L('التوصل إلى حلول أو أفكار جديدة.', 'Coming up with new ideas or solutions.')],
  collaboration: [L('العمل ضمن فريق للوصول إلى نتيجة مشتركة.', 'Working in a team to reach a shared result.')],
  organization: [L('تخطيط عملي وتنظيم وقتي لإنجازه.', 'Planning my work and organising my time.')],
  digital: [L('استخدام الأدوات والتطبيقات الرقمية.', 'Using digital tools and applications.')],
  practical: [L('العمل اليدوي وحل المشكلات العملية.', 'Hands-on work and practical problem solving.')],
};

export const SKILL_NAMES = {
  analytical: L('التفكير التحليلي', 'Analytical thinking'),
  numeracy: L('التعامل مع الأرقام', 'Numeracy'),
  communication: L('التواصل', 'Communication'),
  creativity: L('الإبداع', 'Creativity'),
  collaboration: L('العمل الجماعي', 'Teamwork'),
  organization: L('التنظيم والتخطيط', 'Organisation & planning'),
  digital: L('الأدوات الرقمية', 'Digital tools'),
  practical: L('المهارات العملية', 'Practical skills'),
};

export const VALUES = {
  security: [L('عمل مستقر يوفر لي أمانًا وظيفيًا.', 'A stable job that gives me security.'), L('الاستقرار الوظيفي', 'Job security')],
  helping: [L('عمل يساعد الآخرين ويفيد المجتمع.', 'Work that helps other people and benefits society.'), L('خدمة المجتمع', 'Helping others')],
  creativity: [L('عمل أستطيع فيه ابتكار أشياء جديدة.', 'Work in which I can create new things.'), L('الإبداع والابتكار', 'Creativity')],
  income: [L('دخل مرتفع.', 'A high income.'), L('الدخل', 'Income')],
  autonomy: [L('الاستقلالية في اتخاذ القرارات في عملي.', 'Independence in making decisions about my work.'), L('الاستقلالية', 'Independence')],
  leadership: [L('القيادة والتأثير في القرارات.', 'Leading and influencing decisions.'), L('القيادة والتأثير', 'Leadership & influence')],
  learning: [L('تحديات فكرية وتعلم مستمر.', 'Intellectual challenge and continuous learning.'), L('التعلّم والتحدي الفكري', 'Learning & challenge')],
  balance: [L('وقت كافٍ لأسرتي وحياتي الشخصية.', 'Enough time for my family and personal life.'), L('التوازن بين العمل والحياة', 'Work–life balance')],
};

const mk = (prefix, key, ar, en, extra) => ({
  item_id: `${prefix}-${key}`,
  content: L(ar, en),
  ...extra,
});

export const subjectPreferenceExploratory = {
  instrument_id: 'subject_preference_exploratory',
  name: L('تفضيلات المواد الدراسية (تجريبي)', 'Subject Preferences (exploratory)'),
  purpose: L('أخبرنا بمدى استمتاعك بالمواد الدراسية. إن لم تدرس مادة ما فاختر ذلك.', "Tell us how much you enjoy each school subject. If you haven't studied one, say so."),
  stem: L('ما مدى استمتاعك بدراسة هذه المادة؟', 'How much do you enjoy studying this subject?'),
  construct: 'Subject enjoyment (self-report preference)',
  version: '0.1.0',
  locale_set: ['ar-SA', 'en'],
  usage_class: 'exploratory_synthetic_only',
  scoring: { type: 'per_item_normalized', version: 'item-normalized-1.0.0' },
  items: Object.entries(SUBJECTS).map(([k, v]) =>
    mk('SUBJ', k, v['ar-SA'], v.en, { construct: `SUBJ_${k}`, response_type: 'likert_5_na', scale: 'enjoy_subject', reverse_coded: false, status: 'draft_exploratory_only' }),
  ),
};

export const skillsConfidenceSelfReport = {
  instrument_id: 'skills_confidence_selfreport',
  name: L('الثقة في المهارات (تقييم ذاتي)', 'Skills Confidence (self-report)'),
  purpose: L('هذا تقدير ذاتي لثقتك بنفسك، وليس قياسًا لمهارتك الفعلية.', 'This captures how confident you feel. It is not a measure of how skilled you actually are.'),
  stem: L('ما مدى ثقتك بقدرتك على القيام بما يلي؟', 'How confident are you that you can do the following?'),
  construct: 'Self-reported confidence (not demonstrated competence)',
  version: '0.1.0',
  locale_set: ['ar-SA', 'en'],
  usage_class: 'exploratory_synthetic_only',
  scoring: { type: 'per_item_normalized', version: 'item-normalized-1.0.0' },
  items: Object.entries(SKILLS).map(([k, [v]]) =>
    mk('SKL', k, v['ar-SA'], v.en, { construct: `SKILL_${k}`, response_type: 'likert_5', scale: 'confidence', reverse_coded: false, status: 'draft_exploratory_only' }),
  ),
};

export const workValuesExploratory = {
  instrument_id: 'work_values_exploratory',
  name: L('قيم العمل (تجريبي)', 'Work Values (exploratory)'),
  purpose: L('ما الذي يهمك في عمل المستقبل؟ لا توجد إجابات صحيحة أو خاطئة.', 'What matters to you in a future job? There are no right or wrong answers.'),
  stem: L('ما مدى أهمية ما يلي بالنسبة لك في عملك المستقبلي؟', 'How important is this to you in your future work?'),
  construct: 'Work values (self-report importance)',
  version: '0.1.0',
  locale_set: ['ar-SA', 'en'],
  usage_class: 'exploratory_synthetic_only',
  scoring: { type: 'per_item_normalized', version: 'item-normalized-1.0.0' },
  items: Object.entries(VALUES).map(([k, [v]]) =>
    mk('VAL', k, v['ar-SA'], v.en, { construct: `VALUE_${k}`, response_type: 'likert_5', scale: 'importance', reverse_coded: false, status: 'draft_exploratory_only' }),
  ),
};

export const studentConstraints = {
  instrument_id: 'student_constraints',
  name: L('تفضيلاتي وظروفي', 'My preferences & constraints'),
  purpose: L('تساعدنا على إظهار ما قد يناسب ظروفك. لا تغيّر هذه الإجابات درجات الميول.', 'Helps us flag what may or may not suit your situation. These answers never change your interest scores.'),
  stem: L('اختر ما يناسبك.', 'Choose what suits you.'),
  construct: 'Student-stated constraints (not scored)',
  version: '0.1.0',
  locale_set: ['ar-SA', 'en'],
  usage_class: 'exploratory_synthetic_only',
  scoring: { type: 'choice_passthrough', version: 'choice-passthrough-1.0.0' },
  items: [
    mk('CON', 'instruction_language', 'ما لغة الدراسة التي تفضّلها؟', 'Which language of instruction do you prefer?', {
      construct: 'CONSTRAINT_instruction_language',
      response_type: 'single_choice',
      scale: 'instruction_language',
      options: ['ar', 'en', 'either'],
      reverse_coded: false,
      status: 'draft_exploratory_only',
    }),
  ],
};
