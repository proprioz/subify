import { useNavigate } from 'react-router-dom';
import { Tour } from '../app/Welcome';

/** The first visit's tour, taken again from Settings. */
export function TourPage() {
  const navigate = useNavigate();
  const done = () => navigate('/settings', { replace: true });

  return <Tour onDone={done} finish="Done" />;
}
