import { useState, useRef, useEffect } from 'react';

export default function Chat({ messages, onSend }) {
  const [text, setText] = useState('');
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function send() {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
  }

  return (
    <div className="chat-box">
      <h3>Chat</h3>
      <div className="chat-messages">
        {messages.map((m, i) => (
          <div key={i} className="chat-message">
            <strong>{m.name}: </strong>
            <span>{m.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="chat-input-row">
        <input
          type="text" placeholder="Type a message..."
          value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()}
        />
        <button className="btn accent" onClick={send}>Send</button>
      </div>
    </div>
  );
}
