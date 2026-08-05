import { EOL } from "os"
import { Effect } from "effect"
import PROMPT_GENERATIVE_WIDGET from "@/session/prompt/generative-widget.txt"
import { environment } from "@/session/system"
import { Skill } from "@/skill"
import {
  GENERATIVE_WIDGET_GUIDELINES_SKILL_BODY,
  GENERATIVE_WIDGET_GUIDELINES_SKILL_NAME,
} from "@/skill/generative-widget-guidelines"
import { effectCmd, fail } from "../../effect-cmd"

const schema = "com.openchamber.generative-widget-assets.v1"
const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

export const GenerativeWidgetCommand = effectCmd({
  command: "generative-widget",
  describe: false,
  handler: Effect.fn("Cli.debug.generativeWidget")(function* () {
    const prompts = environment(
      { providerID: "self-check", api: { id: "generative-widget" } },
      { directory: process.cwd(), worktree: process.cwd(), project: {} },
      [],
    ).filter((part) => part === PROMPT_GENERATIVE_WIDGET)
    const [prompt, duplicate] = prompts
    if (!prompt || duplicate) {
      yield* fail("The packaged OpenCode runtime is missing the Generative Widget system prompt")
    }

    const skill = yield* Skill.Service
    const guidelines = yield* skill.get(GENERATIVE_WIDGET_GUIDELINES_SKILL_NAME)
    if (
      !guidelines ||
      guidelines.location !== "<built-in>" ||
      guidelines.content !== GENERATIVE_WIDGET_GUIDELINES_SKILL_BODY
    ) {
      yield* fail("The packaged OpenCode runtime is missing the built-in Generative Widget skill")
    }

    process.stdout.write(
      JSON.stringify({
        schema,
        promptSha256: sha256(prompt),
        skill: GENERATIVE_WIDGET_GUIDELINES_SKILL_NAME,
        skillSha256: sha256(GENERATIVE_WIDGET_GUIDELINES_SKILL_BODY),
      }) + EOL,
    )
  }),
})
