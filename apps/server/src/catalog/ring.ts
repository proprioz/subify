import type { SlotImage, ThumbnailPayload } from '@subify/shared/codec';
import type { RingPlan } from './sizing';

/**
 * The thumbnail ring during one pass (docs/FEATURES.md, D16). The pass overwrites exactly
 * `perPass` cases, the oldest first, whatever happened: thumbnails fill them, decoys the rest.
 * Thumbnails left over wait in the coordinator for the next pass, which places them before new ones.
 */

/** A thumbnail without a case yet. */
export interface WaitingThumbnail {
  source: string;
  externalId: string;
  itemId: string;
  image: SlotImage;
}

/** The cases a pass starting at `next` overwrites, in order. */
export function ringPositions(plan: RingPlan, next: number): number[] {
  return Array.from({ length: plan.perPass }, (_, i) => (next + i) % plan.cases);
}

export class PassRing {
  readonly positions: number[];
  /** Where the next pass starts. */
  readonly next: number;
  /** Thumbnails this pass had no case for, to queue for the next one. */
  readonly waiting: WaitingThumbnail[] = [];
  /** Thumbnails this pass put in a case, in order, for the hour's thumbnail lots. */
  readonly placed: (WaitingThumbnail & { position: number })[] = [];
  private readonly overwriting: Set<number>;
  private readonly written = new Map<number, ThumbnailPayload>();
  private used = 0;
  private reserved: number;

  /**
   * @param old What the cases this pass overwrites held, by position.
   * @param backlog Thumbnails that waited since an earlier pass: their cases are kept for them.
   */
  constructor(
    plan: RingPlan,
    next: number,
    private readonly old: ReadonlyMap<number, ThumbnailPayload>,
    backlog: number,
  ) {
    this.positions = ringPositions(plan, next);
    this.overwriting = new Set(this.positions);
    this.next = (next + plan.perPass) % plan.cases;
    this.reserved = Math.min(backlog, plan.perPass);
  }

  /** The thumbnail's case this pass, or null when none is left: it then waits for the next pass. */
  place(thumbnail: WaitingThumbnail, waited: boolean): number | null {
    if (this.used + (waited ? 0 : this.reserved) >= this.positions.length) {
      this.waiting.push(thumbnail);

      return null;
    }

    if (waited && this.reserved > 0) {
      this.reserved--;
    }

    const position = this.positions[this.used++]!;
    this.written.set(position, { kind: 'thumbnail', itemId: thumbnail.itemId, image: thumbnail.image });
    this.placed.push({ ...thumbnail, position });

    return position;
  }

  /**
   * What a slot's thumbnail becomes as the pass starts: 'kept' unless its case is overwritten
   * now; then the image it held, when the case still holds this item, or null when the ring has
   * already wrapped over it.
   */
  expiring(position: number, itemId: string): 'kept' | SlotImage | null {
    if (!this.overwriting.has(position)) {
      return 'kept';
    }

    const held = this.old.get(position);

    return held?.kind === 'thumbnail' && held.itemId === itemId ? held.image : null;
  }

  /** Every case this pass overwrites, a decoy where no thumbnail went. */
  cases(): [number, ThumbnailPayload][] {
    return this.positions.map((position) => [position, this.written.get(position) ?? { kind: 'empty' }]);
  }
}
