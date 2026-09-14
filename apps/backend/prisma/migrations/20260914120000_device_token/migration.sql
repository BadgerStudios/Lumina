-- An Android device registered for native notifications.
--
-- Separate from PushSubscription rather than an extra column on it: they are different transports
-- with different lifecycles (a browser subscription dies when site data is cleared, an FCM token
-- when the app is reinstalled) and one device commonly holds both. Sending to both is how a phone
-- gets the app's own notification sound while every other client keeps working unchanged.
CREATE TABLE "DeviceToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'android',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);

-- Unique so the same token can never be attributed to two accounts; re-registering after a
-- sign-out is how it moves between them.
CREATE UNIQUE INDEX "DeviceToken_token_key" ON "DeviceToken"("token");
CREATE INDEX "DeviceToken_userId_idx" ON "DeviceToken"("userId");

ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
