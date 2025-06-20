import { paginationOptsValidator } from "convex/server";
import { Agent } from "@convex-dev/agent";
import { components, internal } from "./_generated/api";
import { chat } from "../../../example/examplesModels";
import {
  ActionCtx,
  internalMutation,
  mutation,
  MutationCtx,
  query,
  QueryCtx,
} from "./_generated/server";
import { v } from "convex/values";
import { MINUTE, RateLimiter, SECOND } from "@convex-dev/rate-limiter";
import { DataModel } from "./_generated/dataModel";

const rateLimiter = new RateLimiter(components.rateLimiter, {
  sendMessage: {
    kind: "fixed window",
    period: 5 * SECOND,
    rate: 1,
    // Allow accruing usage up to 2 messages to send within 5s (rollover).
    capacity: 2,
  },
  tokenUsage: {
    kind: "token bucket",
    period: 1 * MINUTE,
    rate: 2000,
    capacity: 10000,
  },
});

// Define an agent similarly to the AI SDK
export const agent = new Agent(components.agent, {
  name: "My First Agent",
  chat: chat,
  instructions: "You are a babysitter of adults who ask bad questions.",
  usageHandler: async (ctx, { userId, usage }) => {
    if (!userId) {
      console.warn("No user ID found in usage handler");
      return;
    }
    // We consume the token usage here, once we know the full usage.
    // This is too late for the first generation, but prevents further requests
    // until we've paid off that debt.
    await rateLimiter.limit(ctx, "tokenUsage", {
      key: userId,
      // You could weight different kinds of tokens differently here.
      count: usage.totalTokens,
      // Reserving the tokens means it won't fail here, but will allow it
      // to go negative, disallowing further requests at the `check` call below.
      reserve: true,
    });
    await ctx.runMutation(internal.rateLimiting.recordUsage, {
      userId,
      totalTokens: usage.totalTokens,
    });
  },
});

// This allows us to have a reactive query on the client for when we can send
// the next message.
export const { getRateLimit, getServerTime } = rateLimiter.hookAPI<DataModel>(
  "sendMessage",
  { key: (ctx) => getUserId(ctx) },
);

// Step 1: Submit a question. It checks to see if you are exceeding rate limits.
export const submitQuestion = mutation({
  args: {
    question: v.string(),
    threadId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getUserId(ctx);
    if (!userId) {
      throw new Error("Unauthorized");
    }
    await rateLimiter.limit(ctx, "sendMessage", {
      key: userId,
      throws: true,
    });
    // We only check here, we don't consume it. We track the total usage after
    // it finishes, which is too late for the first generation, but prevents
    // further requests until we've paid off that debt.
    await rateLimiter.check(ctx, "tokenUsage", {
      key: userId,
      // TODO: estimate tokens based on all messages, not just the new one.
      count: Math.max(
        1,
        await estimateTokens(ctx, args.threadId, args.question),
      ),
      reserve: true,
      throws: true,
    });

    const { threadId } = args.threadId
      ? { threadId: args.threadId }
      : await agent.createThread(ctx, { userId });
    const { messageId } = await agent.saveMessage(ctx, {
      threadId,
      prompt: args.question,
    });
    await ctx.scheduler.runAfter(0, internal.rateLimiting.generateResponse, {
      threadId,
      promptMessageId: messageId,
    });
    return { threadId };
  },
});

// This is a rough estimate of the tokens that will be used.
// It's not perfect, but it's a good enough estimate for a pre-generation check.
async function estimateTokens(
  ctx: QueryCtx,
  threadId: string | undefined,
  question: string,
) {
  // Assume roughly 4 characters per token
  const promptTokens = question.length / 4;
  // Assume 10x as long a reply
  const estimatedOutputTokens = promptTokens * 3;
  if (!threadId) {
    // This is a new thread, so we guess solely based on the question.
    return promptTokens + estimatedOutputTokens;
  }
  const latestMessages = await agent.fetchContextMessages(ctx, {
    threadId,
    userId: await getUserId(ctx),
    messages: [{ role: "user" as const, content: question }],
    contextOptions: { recentMessages: 2 },
  });
  // Our new usage will roughly be the previous tokens + the question.
  // The previous tokens include the tokens for the full message history and
  // output tokens, which will be part of our new history.
  // Note:
  // - It over-counts if the history is longer than the context message
  //   limit, since some messages for the previous prompt won't be included.
  // - It doesn't account for the output tokens.
  const lastUsageMessage = latestMessages
    .reverse()
    .find((message) => message.usage);
  const lastPromptTokens = lastUsageMessage?.usage?.totalTokens ?? 0;
  return lastPromptTokens + promptTokens + estimatedOutputTokens;
}

// Step 2: Generate a response to the question. This is a convenience way of
// making an action that does one generateText LLM call.
export const generateResponse = agent.asTextAction();

// Step 3: Query the messages in a thread
export const listThreadMessages = query({
  args: { threadId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const { threadId, paginationOpts } = args;
    await authorizeThreadAccess(ctx, threadId);
    return agent.listMessages(ctx, { threadId, paginationOpts });
  },
});

/**
 * ==============================
 * Functions for demo purposes.
 * In a real app, you'd use real authentication & authorization.
 * ==============================
 */

async function getUserId(_ctx: QueryCtx | MutationCtx | ActionCtx) {
  // For demo purposes. Usually you'd use auth here.
  return "rate limiting user";
}

async function authorizeThreadAccess(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  threadId: string,
) {
  const userId = await getUserId(ctx);
  // For demo purposes. Usually you'd use auth here.
  if (!userId || !threadId || userId !== "rate limiting user") {
    throw new Error("Unauthorized");
  }
}

export const recordUsage = internalMutation({
  args: { userId: v.string(), totalTokens: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.insert("usage", args);
  },
});

export const getPreviousUsage = query({
  args: { threadId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    // Get usage not accounting for the new question. Do that client-side.
    return estimateTokens(ctx, args.threadId, "");
  },
});
