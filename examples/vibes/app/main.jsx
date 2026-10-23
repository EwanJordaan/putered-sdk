import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  const [ideas, setIdeas] = useState(['Build something small. Make it yours.']);
  const [draft, setDraft] = useState('');
  function add(event) {
    event.preventDefault();
    if (draft.trim()) { setIdeas([...ideas, draft.trim()]); setDraft(''); }
  }
  return <main><p className="eyebrow">YOUR FIRST PUTERED APP</p><h1>A little space<br />for big ideas.</h1>
    <p>Edit <code>app/main.jsx</code> in OpenCode, then click Build app in Vibes.</p>
    <form onSubmit={add}><label htmlFor="idea">What will you make?</label><div><input id="idea" value={draft} onChange={e => setDraft(e.target.value)} placeholder="A new idea…" /><button>Add idea</button></div></form>
    <ul>{ideas.map((idea, index) => <li key={index}>{idea}</li>)}</ul>
    <small>This demo keeps ideas in memory; refreshing resets them.</small></main>;
}
createRoot(document.getElementById('root')).render(<App />);
