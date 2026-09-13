import { useEffect, useRef, useState } from 'react';
import { emitTyping, sendMessage } from '../realtime/socket.js';

export default function Composer({ conversationId, disabled }) {
  const [text, setText] = useState('');
  const typingRef = useRef(false);
  const stopTimer = useRef(null);

  // Stop announcing "typing" if the component goes away mid-sentence.
  useEffect(
    () => () => {
      clearTimeout(stopTimer.current);
      if (typingRef.current) emitTyping(conversationId, false);
    },
    [conversationId],
  );

  function onChange(event) {
    setText(event.target.value);

    if (!typingRef.current) {
      typingRef.current = true;
      emitTyping(conversationId, true);
    }

    clearTimeout(stopTimer.current);
    stopTimer.current = setTimeout(() => {
      typingRef.current = false;
      emitTyping(conversationId, false);
    }, 2000);
  }

  function submit(event) {
    event.preventDefault();
    const body = text.trim();
    if (!body) return;

    // Optimistic: the bubble appears immediately and the outbox owns delivery
    // from here, so this works fine with no connection at all.
    sendMessage({ conversationId, body });
    setText('');

    clearTimeout(stopTimer.current);
    typingRef.current = false;
    emitTyping(conversationId, false);
  }

  return (
    <form className="composer" onSubmit={submit}>
      <input
        value={text}
        onChange={onChange}
        placeholder={disabled ? 'Select a conversation' : 'Write a message'}
        disabled={disabled}
        maxLength={4000}
        aria-label="Message"
      />
      <button type="submit" disabled={disabled || !text.trim()}>
        Send
      </button>
    </form>
  );
}
