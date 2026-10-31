/**
 * Everyday English words with a Vietnamese meaning, for PvP (docs/gamification-plan.md,
 * 5.1 and 5.2): the words a simulated rival brings to a match, and spare wrong
 * answers when the two players' own words are too few. Written for this app.
 */

export interface CommonWord {
  word: string;
  meaning: string;
  pos: 'noun' | 'verb' | 'adjective' | 'adverb';
}

const nouns: Array<[string, string]> = [
  ['journey', 'hành trình'], ['knowledge', 'kiến thức'], ['opportunity', 'cơ hội'], ['decision', 'quyết định'],
  ['experience', 'kinh nghiệm'], ['environment', 'môi trường'], ['government', 'chính phủ'], ['relationship', 'mối quan hệ'],
  ['solution', 'giải pháp'], ['challenge', 'thử thách'], ['agreement', 'thỏa thuận'], ['advantage', 'lợi thế'],
  ['behavior', 'hành vi'], ['community', 'cộng đồng'], ['competition', 'cuộc thi'], ['confidence', 'sự tự tin'],
  ['development', 'sự phát triển'], ['equipment', 'thiết bị'], ['evidence', 'bằng chứng'], ['freedom', 'sự tự do'],
  ['habit', 'thói quen'], ['income', 'thu nhập'], ['influence', 'ảnh hưởng'], ['memory', 'trí nhớ'],
  ['neighbor', 'hàng xóm'], ['patience', 'sự kiên nhẫn'], ['purpose', 'mục đích'], ['quality', 'chất lượng'],
  ['schedule', 'lịch trình'], ['skill', 'kỹ năng'], ['success', 'thành công'], ['traffic', 'giao thông'],
  ['weather', 'thời tiết'], ['wisdom', 'sự khôn ngoan'], ['argument', 'cuộc tranh cãi'], ['attention', 'sự chú ý'],
  ['benefit', 'lợi ích'], ['career', 'sự nghiệp'], ['culture', 'văn hóa'], ['danger', 'mối nguy hiểm'],
];
const verbs: Array<[string, string]> = [
  ['achieve', 'đạt được'], ['admire', 'ngưỡng mộ'], ['avoid', 'tránh'], ['borrow', 'mượn'],
  ['celebrate', 'ăn mừng'], ['compare', 'so sánh'], ['complain', 'phàn nàn'], ['describe', 'mô tả'],
  ['encourage', 'khuyến khích'], ['explain', 'giải thích'], ['forgive', 'tha thứ'], ['improve', 'cải thiện'],
  ['include', 'bao gồm'], ['invite', 'mời'], ['maintain', 'duy trì'], ['negotiate', 'đàm phán'],
  ['observe', 'quan sát'], ['persuade', 'thuyết phục'], ['prepare', 'chuẩn bị'], ['protect', 'bảo vệ'],
  ['recommend', 'giới thiệu, đề xuất'], ['reduce', 'giảm bớt'], ['refuse', 'từ chối'], ['remember', 'nhớ'],
  ['replace', 'thay thế'], ['succeed', 'thành công (làm được)'], ['suggest', 'gợi ý'], ['support', 'ủng hộ'],
  ['survive', 'sống sót'], ['translate', 'dịch'],
];
const adjectives: Array<[string, string]> = [
  ['ancient', 'cổ xưa'], ['anxious', 'lo lắng'], ['brave', 'dũng cảm'], ['brilliant', 'xuất sắc'],
  ['careful', 'cẩn thận'], ['curious', 'tò mò'], ['delicious', 'ngon'], ['enormous', 'khổng lồ'],
  ['familiar', 'quen thuộc'], ['fragile', 'dễ vỡ'], ['generous', 'hào phóng'], ['honest', 'trung thực'],
  ['humble', 'khiêm tốn'], ['jealous', 'ghen tị'], ['lazy', 'lười biếng'], ['loyal', 'trung thành'],
  ['modern', 'hiện đại'], ['narrow', 'hẹp'], ['nervous', 'hồi hộp'], ['obvious', 'rõ ràng'],
  ['patient', 'kiên nhẫn'], ['polite', 'lịch sự'], ['rare', 'hiếm'], ['reliable', 'đáng tin cậy'],
  ['rude', 'thô lỗ'], ['silent', 'im lặng'], ['strict', 'nghiêm khắc'], ['stubborn', 'bướng bỉnh'],
  ['useful', 'hữu ích'], ['wealthy', 'giàu có'],
];
const adverbs: Array<[string, string]> = [
  ['actually', 'thật ra'], ['almost', 'gần như'], ['carefully', 'một cách cẩn thận'], ['certainly', 'chắc chắn'],
  ['eventually', 'cuối cùng'], ['frequently', 'thường xuyên'], ['gradually', 'dần dần'], ['immediately', 'ngay lập tức'],
  ['rarely', 'hiếm khi'], ['suddenly', 'đột nhiên'],
];

export const COMMON_WORDS: readonly CommonWord[] = [
  ...nouns.map(([word, meaning]) => ({ word, meaning, pos: 'noun' as const })),
  ...verbs.map(([word, meaning]) => ({ word, meaning, pos: 'verb' as const })),
  ...adjectives.map(([word, meaning]) => ({ word, meaning, pos: 'adjective' as const })),
  ...adverbs.map(([word, meaning]) => ({ word, meaning, pos: 'adverb' as const })),
];
