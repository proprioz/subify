-- The thumbnail ring's cases grew from 8 KB to 24 KB, for 320×180 thumbnails instead of 120×90.
-- Every blob of a table has the same size, and a case of the old size can't be opened: the ring
-- starts empty again, and refills as the pass turns it. A slot pointing at an empty case shows
-- the placeholder, as it does once the ring has wrapped over its thumbnail.
DELETE FROM thumbnails;
