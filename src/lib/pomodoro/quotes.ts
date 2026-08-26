import type { CharState } from "./types";

export const QUOTES: Record<CharState, string[]> = {
  idle: [
    "一起加油吧…！(๑•̀ㅂ•́)و✧",
    "今天也慢慢来就好～(｡•́‿•̀｡)",
    "我在这儿陪你哦。(◕‿◕✿)",
    "准备好了吗？轻轻点一下就开始。٩(ˊᗜˋ*)و",
  ],
  focus: [
    "专心一点点，我帮你守着时间。(｡•̀ᴗ-)✧",
    "别偷看手机啦…书更有趣。(￣ω￣)",
    "再读一页就好，加油。( •̀ ω •́ )✧",
    "安静一点…这段时光只属于你。shh…",
  ],
  rest: [
    "喝口茶吧，你已经很棒了。(´▽`ʃ♡ƪ)",
    "闭眼休息五分钟，世界不会跑掉～(˘▾˘)~",
    "肩膀放松…呼—— ( ´ ▽ ` )",
    "这杯热可可，是给你的奖励。♪(´ε｀ )",
  ],
  done: [
    "完成啦！超级厉害！☆*:.｡.o(≧▽≦)o.｡.:*☆",
    "又收下一个番茄！庆祝一下～٩(๑>◡<๑)۶",
    "看，星星都为你亮起来了！✦✧",
    "今天的你，闪闪发光。(ﾉ◕ヮ◕)ﾉ*:・ﾟ✧",
  ],
};

export function pickQuote(state: CharState, prev?: string): string {
  const list = QUOTES[state];
  if (list.length === 1) return list[0];
  const pool = prev ? list.filter((q) => q !== prev) : list;
  return pool[Math.floor(Math.random() * pool.length)] ?? list[0];
}
