import { useEffect, useState } from 'react';

export function App() {
  const [users, setUsers] = useState<any[]>([]);
  useEffect(() => {
    fetch('/api/users').then((r) => r.json()).then(setUsers);
  }, []);
  return <ul>{users.map((u) => <li key={u.id} dangerouslySetInnerHTML={{ __html: u.bio }} />)}</ul>;
}
