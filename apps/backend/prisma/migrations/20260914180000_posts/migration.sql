-- The feed: posts, and everything people do to them.
--
-- Separate from Video (the For You feed) rather than folded into it. A video there IS the post —
-- one file, ranked by watch signals, with no text of its own. A post here is text that may or may
-- not carry media, and is read in order. Sharing one model between those two would mean a table
-- where half the columns are null for half the rows, and a ranking pipeline that has to skip most
-- of what it sees.

CREATE TABLE "Post" (
    "id"           BIGSERIAL NOT NULL,
    -- Nullable, and SetNull below: a deleted account must not take the conversation under its posts
    -- with it. The post renders as "Deleted account" and its comment thread survives.
    "authorId"     TEXT,
    "body"         VARCHAR(20000) NOT NULL DEFAULT '',
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt"     TIMESTAMP(3),
    -- Soft delete, matching Message: a deleted post has to stop rendering without orphaning the
    -- shares that point at it.
    "deletedAt"    TIMESTAMP(3),
    -- When set, this post is a share of another one. A share WITH a body is a quote.
    "sharedPostId" BIGINT,
    -- Denormalised counters. A feed page is twenty posts; without these it is sixty aggregate
    -- queries, and the count is read on every render while it changes rarely.
    "likeCount"    INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "shareCount"   INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Post_createdAt_idx" ON "Post"("createdAt" DESC);
CREATE INDEX "Post_authorId_createdAt_idx" ON "Post"("authorId", "createdAt" DESC);
CREATE INDEX "Post_sharedPostId_idx" ON "Post"("sharedPostId");

ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- SetNull rather than Cascade: deleting a post must not silently delete everyone else's shares of
-- it. The share survives and renders as "this post is no longer available".
ALTER TABLE "Post" ADD CONSTRAINT "Post_sharedPostId_fkey"
  FOREIGN KEY ("sharedPostId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Photos and videos attached to a post.
CREATE TABLE "PostMedia" (
    "id"        TEXT NOT NULL,
    "postId"    BIGINT NOT NULL,
    -- 'PHOTO' or 'VIDEO'. A string rather than an enum because the set will grow (audio, a link
    -- card) and widening an enum is a migration where widening a check is not.
    "kind"      TEXT NOT NULL DEFAULT 'PHOTO',
    "url"       TEXT NOT NULL,
    "mimeType"  TEXT NOT NULL DEFAULT '',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "width"     INTEGER,
    "height"    INTEGER,
    "position"  INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PostMedia_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PostMedia_postId_position_idx" ON "PostMedia"("postId", "position");
ALTER TABLE "PostMedia" ADD CONSTRAINT "PostMedia_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A like on a post. Composite primary key rather than a surrogate id: it makes liking twice
-- impossible at the database level instead of in a service that has to remember to check.
CREATE TABLE "PostLike" (
    "postId"    BIGINT NOT NULL,
    "userId"    TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostLike_pkey" PRIMARY KEY ("postId", "userId")
);

CREATE INDEX "PostLike_userId_idx" ON "PostLike"("userId");
ALTER TABLE "PostLike" ADD CONSTRAINT "PostLike_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostLike" ADD CONSTRAINT "PostLike_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A comment, and a reply to one.
CREATE TABLE "PostComment" (
    "id"        BIGSERIAL NOT NULL,
    "postId"    BIGINT NOT NULL,
    "authorId"  TEXT,
    -- One level of threading. A reply points at the comment it answers; a reply to a reply is
    -- stored against the same top-level parent, so a thread cannot nest into an unreadable stair.
    "parentId"  BIGINT,
    "body"      VARCHAR(4000) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt"  TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "likeCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PostComment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PostComment_postId_createdAt_idx" ON "PostComment"("postId", "createdAt");
CREATE INDEX "PostComment_parentId_createdAt_idx" ON "PostComment"("parentId", "createdAt");

ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "PostComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A like on a comment. Same shape and same reasoning as PostLike.
CREATE TABLE "PostCommentLike" (
    "commentId" BIGINT NOT NULL,
    "userId"    TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostCommentLike_pkey" PRIMARY KEY ("commentId", "userId")
);

CREATE INDEX "PostCommentLike_userId_idx" ON "PostCommentLike"("userId");
ALTER TABLE "PostCommentLike" ADD CONSTRAINT "PostCommentLike_commentId_fkey"
  FOREIGN KEY ("commentId") REFERENCES "PostComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostCommentLike" ADD CONSTRAINT "PostCommentLike_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
