-- Tell people when something happens to their post.
--
-- The feed shipped able to be liked, commented on and shared, and able to tell nobody about any of
-- it. A feed with no notifications is one people check twice and then forget, which is the whole
-- retention argument for having built it.

ALTER TYPE "NotificationKind" ADD VALUE 'POST_LIKE';
ALTER TYPE "NotificationKind" ADD VALUE 'POST_COMMENT';
ALTER TYPE "NotificationKind" ADD VALUE 'POST_SHARE';

-- Which post it was about. A column of its own rather than reusing videoId: the inbox links
-- somewhere different for each, and overloading one column is how a link ends up pointing at a
-- video that happens to share an id with a post.
ALTER TABLE "Notification" ADD COLUMN "postId" BIGINT;
