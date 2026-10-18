// FICTIONAL catalog for the synthetic prototype (spec Slice A: "sample program cards marked fictional").
//
// Nothing here describes a real Saudi university, program, curriculum or admission rule.
// RIASEC vectors / subject maps are synthetic placeholders, NOT expert-rated and NOT approved.
// A real catalog needs steward-verified, source-backed data (spec §5.5, WP-05, D-03).
import { deepFreeze } from '../util.js';

const L = (ar, en) => ({ 'ar-SA': ar, en });

export const PATHWAYS = {
  general: L('المسار العام', 'General path'),
  health_life: L('مسار الصحة والحياة', 'Health & life sciences path'),
  cs_engineering: L('مسار علوم الحاسب والهندسة', 'Computer science & engineering path'),
  business_admin: L('مسار إدارة الأعمال', 'Business administration path'),
  sharia: L('المسار الشرعي', 'Sharia path'),
};

export const UNIVERSITIES = {
  'uni-demo-a': { name: L('جامعة العرض (أ) — وهمية', 'Demo University A — fictional'), city: L('مدينة افتراضية ١', 'Fictional City 1') },
  'uni-demo-b': { name: L('جامعة العرض التقنية (ب) — وهمية', 'Demo Technical University B — fictional'), city: L('مدينة افتراضية ٢', 'Fictional City 2') },
  'uni-demo-c': { name: L('جامعة العرض للعلوم الصحية (ج) — وهمية', 'Demo Health Sciences University C — fictional'), city: L('مدينة افتراضية ١', 'Fictional City 1') },
};

export const CLUSTERS = {
  computing: L('الحوسبة والتقنية', 'Computing & technology'),
  engineering: L('الهندسة والعمارة', 'Engineering & architecture'),
  health: L('الصحة والعلوم الحياتية', 'Health & life sciences'),
  business: L('الأعمال والمالية', 'Business & finance'),
  creative: L('التصميم والإعلام', 'Design & media'),
  people: L('التعليم والعلوم الاجتماعية', 'Education & social sciences'),
};

// vec: R, I, A, S, E, C (0-100 synthetic placeholders)
// subj: weights 0-1 over SUBJECTS; vals: weights over VALUES; skl: weights over SKILLS
// prep: required preparation (subject grade minimums)
const P = (id, uni, cluster, nameAr, nameEn, lang, vec, subj, vals, skl, prep, rule) => ({
  program_id: `prog-demo-${id}`,
  university_id: uni,
  college: null,
  official_name: L(nameAr, nameEn),
  degree_level: 'bachelor',
  instruction_language: lang,
  taxonomy_code: `DEMO-${cluster.toUpperCase().slice(0, 4)}-${id.toUpperCase().slice(0, 4)}`,
  field_cluster: cluster,
  status: 'active',
  fictional: true,
  profile: {
    model_version: 'program-profile-demo-0.1',
    source: 'synthetic_placeholder',
    reviewer: null,
    evidence_refs: [],
    riasec: { R: vec[0], I: vec[1], A: vec[2], S: vec[3], E: vec[4], C: vec[5] },
    subject_relevance: subj,
    values_emphasis: vals,
    skills_emphasis: skl,
    required_preparation: prep.map(([subject, min_grade]) => ({ subject, min_grade })),
  },
  rule,
});

// rule: [pathways, secondary_percentage_min, gat_min, saat_min]. null = condition not applicable.
export const PROGRAMS = deepFreeze([
  P('cs', 'uni-demo-a', 'computing', 'علوم الحاسب', 'Computer Science', 'en', [30, 85, 35, 15, 30, 60], { math: 1, computer: 1, physics: 0.5, english: 0.5 }, { learning: 1, income: 0.6, autonomy: 0.5 }, { analytical: 1, numeracy: 0.8, digital: 1 }, [['math', 80], ['computer', 75]], [['cs_engineering', 'general'], 85, 80, 75]),
  P('se', 'uni-demo-b', 'computing', 'هندسة البرمجيات', 'Software Engineering', 'en', [35, 75, 40, 15, 35, 55], { math: 0.9, computer: 1, english: 0.6 }, { creativity: 0.7, income: 0.6, autonomy: 0.6 }, { analytical: 0.9, digital: 1, collaboration: 0.6 }, [['math', 80], ['computer', 80]], [['cs_engineering'], 88, 82, 80]),
  P('me', 'uni-demo-b', 'engineering', 'الهندسة الميكانيكية', 'Mechanical Engineering', 'en', [85, 70, 20, 10, 30, 40], { math: 1, physics: 1, chemistry: 0.3 }, { security: 0.6, learning: 0.6, income: 0.5 }, { practical: 1, numeracy: 0.9, analytical: 0.8 }, [['math', 85], ['physics', 80]], [['cs_engineering'], 88, 82, 82]),
  P('ce', 'uni-demo-a', 'engineering', 'الهندسة المدنية', 'Civil Engineering', 'en', [80, 60, 35, 15, 35, 50], { math: 1, physics: 0.8, art: 0.2 }, { security: 0.7, leadership: 0.5, income: 0.5 }, { practical: 0.8, numeracy: 0.9, organization: 0.7 }, [['math', 80], ['physics', 75]], [['cs_engineering', 'general'], 84, 78, 75]),
  P('arch', 'uni-demo-b', 'engineering', 'العمارة', 'Architecture', 'en', [65, 50, 85, 20, 30, 40], { art: 0.8, math: 0.6, physics: 0.4 }, { creativity: 1, autonomy: 0.6, learning: 0.4 }, { creativity: 1, practical: 0.6, communication: 0.6 }, [['math', 75]], [['cs_engineering', 'general'], 84, 78, 70]),
  P('med', 'uni-demo-c', 'health', 'الطب البشري', 'Medicine', 'en', [25, 85, 15, 85, 25, 40], { biology: 1, chemistry: 1, physics: 0.4, english: 0.6 }, { helping: 1, learning: 0.8, security: 0.5 }, { analytical: 0.8, communication: 0.7, collaboration: 0.6 }, [['biology', 90], ['chemistry', 90]], [['health_life'], 95, 90, 90]),
  P('pharm', 'uni-demo-c', 'health', 'الصيدلة', 'Pharmacy', 'en', [30, 80, 10, 60, 20, 50], { chemistry: 1, biology: 0.8, math: 0.4 }, { helping: 0.7, security: 0.7, learning: 0.6 }, { analytical: 0.7, organization: 0.7, numeracy: 0.6 }, [['chemistry', 85], ['biology', 80]], [['health_life'], 90, 85, 85]),
  P('nurs', 'uni-demo-c', 'health', 'التمريض', 'Nursing', 'both', [35, 55, 10, 90, 20, 45], { biology: 0.9, chemistry: 0.5, english: 0.4 }, { helping: 1, security: 0.7, balance: 0.4 }, { collaboration: 1, communication: 0.8, practical: 0.6 }, [['biology', 75]], [['health_life', 'general'], 80, 70, 65]),
  P('bio', 'uni-demo-a', 'health', 'التقنية الحيوية', 'Biotechnology', 'en', [40, 90, 15, 30, 15, 45], { biology: 1, chemistry: 0.9, math: 0.4 }, { learning: 1, creativity: 0.5, autonomy: 0.5 }, { analytical: 1, practical: 0.6, numeracy: 0.5 }, [['biology', 85], ['chemistry', 80]], [['health_life', 'general'], 86, 80, 80]),
  P('ba', 'uni-demo-a', 'business', 'إدارة الأعمال', 'Business Administration', 'both', [15, 30, 25, 45, 85, 60], { business: 1, math: 0.5, english: 0.6 }, { leadership: 1, income: 0.8, autonomy: 0.5 }, { communication: 1, collaboration: 0.8, organization: 0.7 }, [['english', 70]], [['business_admin', 'general'], 80, 70, null]),
  P('acc', 'uni-demo-a', 'business', 'المحاسبة', 'Accounting', 'both', [10, 35, 5, 20, 40, 90], { business: 0.9, math: 0.8, computer: 0.4 }, { security: 1, income: 0.6, balance: 0.5 }, { numeracy: 1, organization: 1, digital: 0.5 }, [['math', 70]], [['business_admin', 'general'], 78, 70, null]),
  P('gd', 'uni-demo-b', 'creative', 'التصميم الجرافيكي', 'Graphic Design', 'both', [35, 20, 92, 25, 35, 25], { art: 1, computer: 0.5, english: 0.3 }, { creativity: 1, autonomy: 0.8, balance: 0.3 }, { creativity: 1, digital: 0.9, communication: 0.5 }, [], [['general', 'cs_engineering', 'business_admin'], 75, 65, null]),
  P('media', 'uni-demo-a', 'creative', 'الإعلام والاتصال', 'Media & Communication', 'ar', [20, 30, 80, 55, 70, 25], { arabic: 0.8, english: 0.7, art: 0.4 }, { creativity: 0.8, autonomy: 0.6, leadership: 0.4 }, { communication: 1, creativity: 0.8, collaboration: 0.5 }, [['arabic', 75]], [['general', 'sharia'], 76, 65, null]),
  P('edu', 'uni-demo-a', 'people', 'التعليم الابتدائي', 'Primary Education', 'ar', [10, 30, 45, 92, 40, 45], { arabic: 0.7, social: 0.5, islamic: 0.4 }, { helping: 1, balance: 0.8, security: 0.7 }, { communication: 1, collaboration: 0.8, organization: 0.7 }, [['arabic', 75]], [['general', 'sharia'], 75, 65, null]),
  P('psy', 'uni-demo-a', 'people', 'علم النفس', 'Psychology', 'ar', [5, 70, 30, 85, 30, 35], { biology: 0.4, social: 0.7, english: 0.5 }, { helping: 1, learning: 0.8, autonomy: 0.4 }, { communication: 1, analytical: 0.7, collaboration: 0.6 }, [['english', 70]], [['general', 'health_life'], 80, 70, null]),
]);

export const getProgram = (id) => PROGRAMS.find((p) => p.program_id === id) || null;

/** Programs with deliberately unusual source states so every readiness path is demonstrable. */
export const SEED_RULE_EXCEPTIONS = {
  'prog-demo-nurs': 'stale', // review_due_at is in the past
  'prog-demo-psy': 'conflicting', // two publishers disagree
  'prog-demo-media': 'none', // no verified rule exists
};
