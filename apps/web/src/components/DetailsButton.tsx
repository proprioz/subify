import type { Failure } from '../data/error-report';
import { useErrorDetails } from '../ui/error-details';

/** “Details” after an error's sentence: opens everything known about it, to copy. */
export function DetailsButton({ failure }: { failure: Failure }) {
  const details = useErrorDetails();

  return (
    <button type="button" className="text-link" onClick={() => details(failure)}>
      Details
    </button>
  );
}
