import { memo } from "react";

export const QuoteBubble = memo(function QuoteBubble({ text }: { text: string }) {
  return (
    <div className="quote-bubble relative px-4 py-3">
      <p className="line-clamp-2 text-pretty text-center text-sm leading-snug text-ink dark:text-cream">
        {text}
      </p>
    </div>
  );
});
