
import { useState } from 'react';
import JoinPage from './pages/JoinPage.jsx';
import RoomPage from './pages/RoomPage.jsx';

function App() {
  const [session, setSession] = useState(null);

  if (!session) return <JoinPage onJoined={setSession} />;

  return (
    <RoomPage
      roomCode={session.roomCode}
      role={session.role}
      userId={session.userId}
      name={session.name}
      token={session.token}
      initialState={session.state}
      onLeave={() => setSession(null)}
    />
  );
}

export default App;