import { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import type { ChatMessage } from '@couch/types';

const COLORS = ['#e8554d', '#4d9be8', '#5dc961', '#e8c44d', '#d47cff', '#62d5d5', '#ff935c', '#f2f2f2'];

interface ChatPanelProps {
  messages: ChatMessage[];
  readOnly?: boolean;
  onSend?: (text: string) => void;
  className?: string;
}

export function ChatPanel({ messages, readOnly, onSend, className }: ChatPanelProps) {
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = input.trim();
    if (trimmed) {
      onSend?.(trimmed);
      setInput('');
    }
  };

  const rootClass = ['chat-panel', readOnly ? 'readonly' : null, className ?? null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rootClass}>
      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">No messages yet</div>
        ) : (
          messages.map((m) => (
            <div className="chat-msg" key={m.id}>
              <span className="chat-msg-name" style={{ color: COLORS[m.colorIdx % COLORS.length] }}>
                {m.name}
              </span>
              <span className="chat-msg-text">{m.text}</span>
            </div>
          ))
        )}
      </div>
      {!readOnly && (
        <form className="chat-input-row" onSubmit={handleSubmit}>
          <input
            className="chat-input"
            maxLength={240}
            placeholder="Message…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button className="chat-send" type="submit">
            <Send size={16} />
          </button>
        </form>
      )}
    </div>
  );
}
