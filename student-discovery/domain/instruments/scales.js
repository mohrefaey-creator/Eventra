// Localized semantic anchors. Keys are stable identifiers; labels are display copy.
// Arabic copy needs review by a native education/localization expert (spec §9).
const L = (ar, en) => ({ 'ar-SA': ar, en });

export const SCALES = {
  interest_like: {
    1: L('لا أحبه إطلاقًا', 'Strongly dislike'),
    2: L('لا أحبه', 'Dislike'),
    3: L('محايد', 'Neutral'),
    4: L('أحبه', 'Like'),
    5: L('أحبه جدًا', 'Strongly like'),
  },
  enjoy_subject: {
    1: L('لا أستمتع إطلاقًا', 'Not at all'),
    2: L('قليلًا', 'A little'),
    3: L('إلى حد ما', 'Somewhat'),
    4: L('كثيرًا', 'Quite a lot'),
    5: L('كثيرًا جدًا', 'Very much'),
    na: L('لم أدرس هذه المادة', "I haven't studied this"),
  },
  confidence: {
    1: L('غير واثق إطلاقًا', 'Not at all confident'),
    2: L('واثق قليلًا', 'Slightly confident'),
    3: L('واثق إلى حد ما', 'Moderately confident'),
    4: L('واثق جدًا', 'Very confident'),
    5: L('واثق تمامًا', 'Completely confident'),
  },
  importance: {
    1: L('غير مهم', 'Not important'),
    2: L('مهم قليلًا', 'Slightly important'),
    3: L('مهم إلى حد ما', 'Moderately important'),
    4: L('مهم جدًا', 'Very important'),
    5: L('بالغ الأهمية', 'Extremely important'),
  },
  instruction_language: {
    ar: L('العربية', 'Arabic'),
    en: L('الإنجليزية', 'English'),
    either: L('كلاهما مناسب', 'Either is fine'),
  },
};

export const LIKERT_5 = ['1', '2', '3', '4', '5'];
