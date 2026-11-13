import { GraphError, GraphUncertainError } from "@relay/channels";
import { fileStorage, newId, type Publisher, publishInboxEvent } from "@relay/core";
import type { TemplateContent, TemplateDefinition, TemplatePurpose } from "@relay/core/templates";
import { and, type createDb, eq, inArray, schema } from "@relay/db";
import { type Job, UnrecoverableError } from "bullmq";
import { accountRef, channels } from "./registry";

type Db = ReturnType<typeof createDb>["db"];

/*
 * Templates on channels: publish (first time or a new version), remove, and import what already
 * exists on a channel. Channels that review templates report back later through the
 * template.status_changed event (see ingest.ts); channels without review are ready at once.
 */

export type TemplateJob =
  /** Send the template to every chosen account of one scope (accounts in a scope share templates). */
  | { action: "publish"; templateId: string; scope: string }
  | { action: "remove"; channelAccountId: string; externalId: string; slug: string }
  | { action: "sync"; channelAccountId: string };

export function createTemplateProcessor({ db, redis }: { db: Db; redis: Publisher }) {
  const storage = fileStorage();
  const announce = (organizationId: string, templateId: string) =>
    publishInboxEvent(redis, organizationId, { type: "template.updated", templateId });

  async function headerFile(content: TemplateContent) {
    const h = content.header;
    if (!h || h.kind === "text" || !h.attachmentId) return null;
    const [file] = await db
      .select()
      .from(schema.attachment)
      .where(eq(schema.attachment.id, h.attachmentId))
      .limit(1);
    if (!file?.storageKey) throw new UnrecoverableError("The header file is missing; choose it again.");
    return {
      bytes: await storage.get(file.storageKey),
      mimeType: file.mimeType ?? "application/octet-stream",
      fileName: file.fileName ?? file.id,
    };
  }

  async function publish(job: Job<TemplateJob>, templateId: string, scope: string) {
    const [template] = await db
      .select()
      .from(schema.messageTemplate)
      .where(eq(schema.messageTemplate.id, templateId))
      .limit(1);
    if (!template) return;
    const copies = await db
      .select({ copy: schema.templateChannel, account: schema.channelAccount })
      .from(schema.templateChannel)
      .innerJoin(schema.channelAccount, eq(schema.channelAccount.id, schema.templateChannel.channelAccountId))
      .where(and(eq(schema.templateChannel.templateId, templateId), eq(schema.templateChannel.scope, scope)));
    const first = copies[0];
    if (!first) return;
    const adapter = channels().get(first.account.type);
    if (!adapter?.templates) throw new UnrecoverableError("This channel has no templates");
    const definition: TemplateDefinition = {
      slug: template.slug,
      language: template.language,
      purpose: template.purpose as TemplatePurpose,
      content: template.content as unknown as TemplateContent,
      variables: template.variables,
    };
    const ids = copies.map((c) => c.copy.id);
    const existing = copies.find((c) => c.copy.externalId)?.copy.externalId ?? null;
    try {
      const file = await headerFile(definition.content);
      const ref = accountRef(first.account);
      const result = existing
        ? { externalId: existing, ...(await adapter.templates.update(ref, existing, definition, file)) }
        : await adapter.templates.submit(ref, definition, file);
      await db
        .update(schema.templateChannel)
        .set({
          externalId: result.externalId,
          status: result.status,
          reason: null,
          error: null,
          submittedAt: new Date(),
          decidedAt: result.status === "ready" ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(inArray(schema.templateChannel.id, ids));
    } catch (err) {
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const temporary =
        err instanceof GraphUncertainError ||
        (err instanceof GraphError && (err.kind === "retryable" || err.kind === "rateLimited"));
      if (temporary && !lastAttempt) throw err;
      // The channel refused it (or kept failing): show why, in its words, on every copy.
      const message =
        err instanceof GraphError
          ? ((err.details?.error_user_msg as string | undefined) ?? err.message)
          : err instanceof Error
            ? err.message
            : String(err);
      await db
        .update(schema.templateChannel)
        .set({ status: "needs_changes", reason: message, error: message, updatedAt: new Date() })
        .where(inArray(schema.templateChannel.id, ids));
      throw new UnrecoverableError(message);
    } finally {
      await announce(template.organizationId, template.id);
    }
  }

  async function remove(channelAccountId: string, externalId: string, slug: string) {
    const [account] = await db
      .select()
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.id, channelAccountId))
      .limit(1);
    const adapter = account ? channels().get(account.type) : null;
    if (!account || !adapter?.templates) return;
    await adapter.templates.remove(accountRef(account), externalId, slug);
  }

  /** Brings in templates that already exist on the channel, such as ones made in WhatsApp Manager. */
  async function sync(channelAccountId: string) {
    const [account] = await db
      .select()
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.id, channelAccountId))
      .limit(1);
    const adapter = account ? channels().get(account.type) : null;
    if (!account || !adapter?.templates) return;
    const ref = accountRef(account);
    const scope = adapter.templates.scope(ref);
    const found = await adapter.templates.list(ref);
    for (const t of found) {
      if (!t.externalId || !t.definition.slug) continue;
      await db
        .insert(schema.messageTemplate)
        .values({
          id: newId("template"),
          organizationId: account.organizationId,
          name: t.definition.slug.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
          slug: t.definition.slug,
          language: t.definition.language,
          purpose: t.definition.purpose,
          content: t.definition.content as unknown as Record<string, unknown>,
          variables: t.definition.variables,
          source: "channel",
        })
        .onConflictDoNothing();
      const [template] = await db
        .select({ id: schema.messageTemplate.id })
        .from(schema.messageTemplate)
        .where(
          and(
            eq(schema.messageTemplate.organizationId, account.organizationId),
            eq(schema.messageTemplate.slug, t.definition.slug),
            eq(schema.messageTemplate.language, t.definition.language),
          ),
        )
        .limit(1);
      if (!template) continue;
      await db
        .insert(schema.templateChannel)
        .values({
          id: newId("templateChannel"),
          organizationId: account.organizationId,
          templateId: template.id,
          channelAccountId: account.id,
          scope,
          externalId: t.externalId,
          status: t.status,
          reason: t.reason,
          decidedAt: t.status === "ready" ? new Date() : null,
        })
        .onConflictDoUpdate({
          target: [schema.templateChannel.templateId, schema.templateChannel.channelAccountId],
          set: { externalId: t.externalId, status: t.status, reason: t.reason, updatedAt: new Date() },
        });
      await announce(account.organizationId, template.id);
    }
  }

  return async function processTemplate(job: Job<TemplateJob>) {
    const d = job.data;
    if (d.action === "publish") return publish(job, d.templateId, d.scope);
    if (d.action === "remove") return remove(d.channelAccountId, d.externalId, d.slug);
    return sync(d.channelAccountId);
  };
}
