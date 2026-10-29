import { useUiLanguage } from '../app-context.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { BUTTON_SECONDARY, CARD, HELP, PAGE, SECTION_TITLE } from '../components/ui.js';
import { pick } from '../lib/i18n.js';
import { ROUTES } from '../lib/router.js';

/** The plain-language explanation behind the FSRS-only interface. */
export function HelpPage() {
  const language = useUiLanguage();

  return (
    <div className={`${PAGE} mx-auto max-w-3xl`}>
      <PageHeader
        title={pick(language, 'Help', 'Trợ giúp')}
        description={pick(
          language,
          'How memory strength, FSRS, goals and archiving fit together.',
          'Sức nhớ, FSRS, mục tiêu và lưu trữ liên quan với nhau thế nào.',
        )}
        actions={
          <Link to={ROUTES.settings} className={BUTTON_SECONDARY}>
            {pick(language, 'Open Settings', 'Mở Cài đặt')}
          </Link>
        }
      />

      <div className="mt-6 flex flex-col gap-5">
        <section className={`${CARD} p-5`}>
          <h2 className={SECTION_TITLE}>{pick(language, 'Memory strength', 'Sức nhớ')}</h2>
          <p className={`${HELP} mt-2`}>
            {pick(
              language,
              'The 1–10 number and its label are a display scale derived from FSRS stability: how long the memory is expected to last. New / Learning / Familiar / Strong / Master are labels on that scale, not a second scheduler.',
              'Con số 1–10 và nhãn đi kèm là thang hiển thị suy ra từ độ bền FSRS: thời gian ước tính ký ức còn lại. New / Learning / Familiar / Strong / Master chỉ là nhãn trên thang này, không phải bộ lập lịch thứ hai.',
            )}
          </p>
          <ul className="mt-3 m-0 flex list-none flex-col divide-y divide-line p-0 text-sm">
            {[
              ['New', pick(language, 'Never studied, or stability under a day.', 'Chưa ôn lần nào, hoặc độ bền dưới một ngày.')],
              ['Learning', pick(language, 'Roughly 1–6 days.', 'Khoảng 1–6 ngày.')],
              ['Familiar', pick(language, 'Roughly 7–29 days.', 'Khoảng 7–29 ngày.')],
              ['Strong', pick(language, 'Roughly 30–364 days.', 'Khoảng 30–364 ngày.')],
              ['Master', pick(language, 'A year or more. A label, not retirement.', 'Một năm trở lên. Chỉ là nhãn, không phải nghỉ.')],
            ].map(([band, description]) => (
              <li key={band} className="grid grid-cols-[6.5rem_1fr] gap-3 py-2 first:pt-0 last:pb-0">
                <span className="font-semibold text-ink">{band}</span>
                <span className="text-muted">{description}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className={`${CARD} p-5`}>
          <h2 className={SECTION_TITLE}>{pick(language, 'Strength can fall', 'Sức nhớ có thể giảm')}</h2>
          <p className={`${HELP} mt-2`}>
            {pick(
              language,
              'A missed answer or a long gap can lower the number. The card shows a quiet “needs review” arrow; it does not show a red warning, a best-ever score, or a reason to feel ashamed. Answer honestly so FSRS can schedule the word well.',
              'Một lần quên hoặc khoảng nghỉ dài có thể làm chỉ số giảm. Thẻ chỉ hiện mũi tên nhẹ “cần ôn lại”; không có cảnh báo đỏ, không có điểm cao nhất để phải giữ, cũng không có gì phải xấu hổ. Trả lời thành thật để FSRS lập lịch tốt.',
            )}
          </p>
        </section>

        <section className={`${CARD} p-5`}>
          <h2 className={SECTION_TITLE}>{pick(language, 'FSRS and the two answers', 'FSRS và hai câu trả lời')}</h2>
          <p className={`${HELP} mt-2`}>
            {pick(
              language,
              'Remember and Not remember are the only answers. FSRS stores the result and chooses the next date. It never retires a word and has no maximum interval: a stable word can wait a long time, and a fragile one comes back soon.',
              'Nhớ và Không nhớ là hai câu trả lời duy nhất. FSRS ghi kết quả rồi chọn ngày tiếp theo. Nó không bao giờ cho từ nghỉ và không có khoảng cách tối đa: từ bền có thể chờ rất lâu, từ mong manh sẽ quay lại sớm.',
            )}
          </p>
          <p className={`${HELP} mt-2`}>
            {pick(
              language,
              'Target retention lives under Advanced in Settings. The default is 90%. Changing it changes future intervals, not the strength scale.',
              'Tỉ lệ ghi nhớ mục tiêu nằm trong mục Nâng cao ở Cài đặt. Mặc định là 90%. Thay đổi nó làm đổi khoảng cách ôn sau này, không đổi thang sức nhớ.',
            )}
          </p>
        </section>

        <section className={`${CARD} p-5`}>
          <h2 className={SECTION_TITLE}>{pick(language, 'Daily goals and streaks', 'Mục tiêu ngày và chuỗi')}</h2>
          <p className={`${HELP} mt-2`}>
            {pick(
              language,
              'There are two goals: new words added that day, and the day’s due reviews. The review goal is not a number you choose — it is every card that is due, met once nothing is left to study: no word due and no new word waiting; adding a word opens it again. Both make a day count towards the streak. A goal never stops a session — you can always review more. On a day you do not want to add words, maintenance mode sets the new-word goal to 0.',
              'Có hai mục tiêu: số từ mới thêm vào trong ngày và lượt ôn trong ngày. Mục tiêu ôn không phải con số bạn chọn — đó là toàn bộ từ đến hạn, đạt khi không còn gì để học: không còn từ đến hạn và không có từ mới đang chờ; thêm từ mới thì mục tiêu mở lại. Cả hai cùng làm một ngày được tính vào chuỗi. Mục tiêu không bao giờ dừng buổi ôn — bạn luôn có thể ôn thêm. Nếu không muốn thêm từ, chế độ duy trì đặt mục tiêu từ mới bằng 0.',
            )}
          </p>
        </section>

        <section className={`${CARD} p-5`}>
          <h2 className={SECTION_TITLE}>{pick(language, 'XP, levels and quests', 'XP, level và nhiệm vụ')}</h2>
          <p className={`${HELP} mt-2`}>
            {pick(
              language,
              'Every answer earns XP, whether you remembered the word or not, so answering honestly never costs you anything: a due review is 10 XP, a word studied for the first time 17, practice and reviews taken early or at random 5. Meeting your daily goals adds 50. Answering many in a row builds a combo (+10% from 10, +25% from 25, +50% from 50), and coming back after three days or more doubles XP for a day. Bonuses add together. XP never changes when a word is due.',
              'Mỗi câu trả lời đều được XP, dù bạn nhớ hay quên, nên trả lời thành thật không bao giờ thiệt: ôn đúng hạn 10 XP, học từ mới lần đầu 17, luyện tập và ôn sớm hay ôn ngẫu nhiên 5. Đạt đủ mục tiêu ngày được thêm 50. Trả lời liên tục tạo combo (+10% từ câu 10, +25% từ 25, +50% từ 50), và quay lại sau từ ba ngày nghỉ được nhân đôi XP trong một ngày. Các phần thưởng cộng lại với nhau. XP không bao giờ thay đổi lịch ôn của từ.',
            )}
          </p>
          <p className={`${HELP} mt-2`}>
            {pick(
              language,
              'Each day brings three quests and each week one, with XP of their own. Studying every day moves the seven-day check-in along; a missed day starts it again. Every 7 days of streak gives a streak freeze (you can hold two): a missed day uses one, so the streak carries on. Badges come in tiers and are counted from your whole history. Rewards wait on the dashboard until you claim them.',
              'Mỗi ngày có ba nhiệm vụ và mỗi tuần một nhiệm vụ, đều có XP riêng. Học mỗi ngày giúp điểm danh 7 ngày đi tiếp; lỡ một ngày thì bắt đầu lại. Cứ mỗi 7 ngày streak được tặng một lần đóng băng (giữ tối đa hai): lỡ một ngày sẽ tự dùng một cái để giữ chuỗi. Huy hiệu có nhiều bậc và được tính từ toàn bộ lịch sử học. Phần thưởng chờ ở Dashboard cho tới khi bạn nhận.',
            )}
          </p>
          <p className={`${HELP} mt-2`}>
            {pick(
              language,
              'Review early takes words due in the next few days (you choose how many) and counts toward the schedule, as any review does. Random review takes studied words at random and, unless you switch counting on, leaves the schedule as it was.',
              'Ôn sớm lấy các từ sẽ đến hạn trong vài ngày tới (bạn chọn số ngày) và tính vào lịch như mọi lượt ôn. Ôn ngẫu nhiên lấy các từ đã học theo thứ tự ngẫu nhiên và, trừ khi bạn bật tính lịch, giữ nguyên lịch ôn.',
            )}
          </p>
        </section>

        <section className={`${CARD} p-5`}>
          <h2 className={SECTION_TITLE}>{pick(language, 'Archiving, not retiring', 'Lưu trữ, không tự nghỉ')}</h2>
          <p className={`${HELP} mt-2`}>
            {pick(
              language,
              'Archiving is a bulk action in the Bank. Archived words leave the review queue and the dashboard but stay in the Bank under the Archived filter, and can always be resumed. FSRS itself never archives a word.',
              'Lưu trữ là thao tác hàng loạt trong Sổ từ. Từ đã lưu trữ rời hàng đợi và trang tổng quan nhưng vẫn ở Sổ từ dưới bộ lọc Lưu trữ, và luôn có thể bỏ lưu trữ. Bản thân FSRS không bao giờ tự lưu trữ từ.',
            )}
          </p>
        </section>

        <section className={`${CARD} p-5`}>
          <h2 className={SECTION_TITLE}>{pick(language, 'Practice score', 'Điểm luyện tập')}</h2>
          <p className={`${HELP} mt-2`}>
            {pick(
              language,
              'Practice score is an estimate from your practice answers across modes. It is not memory strength and it never changes the schedule. Word meanings and examples are never translated by the interface language.',
              'Điểm luyện tập là ước lượng từ các câu trả lời luyện tập ở nhiều chế độ. Nó không phải sức nhớ và không bao giờ đổi lịch ôn. Ngôn ngữ giao diện không dịch nghĩa từ hay ví dụ.',
            )}
          </p>
        </section>

        <div className="flex flex-wrap gap-2">
          <Link to={ROUTES.dashboard} className={BUTTON_SECONDARY}>
            {pick(language, 'Back to dashboard', 'Về tổng quan')}
          </Link>
          <Link to={ROUTES.settings} className={BUTTON_SECONDARY}>
            {pick(language, 'Change goals or retention', 'Đổi mục tiêu hoặc tỉ lệ ghi nhớ')}
          </Link>
        </div>
      </div>
    </div>
  );
}
