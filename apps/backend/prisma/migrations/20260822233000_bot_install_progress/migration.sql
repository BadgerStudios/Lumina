-- Progress reported BY the worker rather than inferred by the UI from step names: the client
-- should not have to know the pipeline's shape to draw a bar, and a renamed step must not silently
-- freeze it.
ALTER TABLE "BotInstallRequest" ADD COLUMN "progress" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BotInstallRequest" ADD COLUMN "phase" TEXT;
