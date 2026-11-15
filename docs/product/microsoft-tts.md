# Voiceovers: Microsoft Text to Speech

Every video Faceful makes from a timeline has a voice. When nobody speaks in it (no recorded take, no presenter video with its own sound), production reads the script aloud first:

1. **The persona's own voices**, when the video was made with a persona whose consent is live, in their fallback order (`persona_voices`, priority 1 first): Cartesia, ElevenLabs or MiniMax on fal clones.
2. **A stock voice** otherwise, or when each of those fails: Microsoft Text to Speech (Azure AI Speech), then the optional ElevenLabs or Cartesia stock voices.

Where it happens:

- **The engine** (`packages/engine/src/voice.ts`) makes the voice when a render is queued (`queue_reel_render`, the wizard's **Create**, the canvas's **Render video**). The voice is saved as a `voice` draft file in the project, made once per script and voice, and the render job gets the voice clip, word timings and captions timed to them. The saved edit is not changed.
- **The render worker** (`workers/reel-render`) makes it when a job still arrives without one: an engine without speech keys, or one deployed before voiceovers. It reads what the engine tells it, or the captions. A job that needs a voice and cannot get one fails with the reason instead of rendering a silent video.

Both use the same code (`packages/engine/src/voice-providers.ts`). `GET /v1/health` lists the engine's speech services under `voiceover.services`.

## 1. Create the Speech resource

In the [Azure portal](https://portal.azure.com):

1. **Create a resource** → search **Speech** (publisher Microsoft, "Azure AI services | Speech") → **Create**.
2. Pick the subscription and a resource group (for example `faceful`).
3. **Region**: West Europe or Sweden Central is closest to the engine (Vercel `fra1`). Every region with neural voices has the Greek ones.
4. **Name**: for example `faceful-speech`. **Pricing tier**: `Free F0` to try it (a monthly allowance of characters, limited requests per second), `Standard S0` for production. Check the current prices on the Azure pricing page; neural voices are billed per character read.
5. **Review + create**. When it is ready, open the resource → **Keys and Endpoint**. Note **KEY 1**, **Location/Region** (for example `westeurope`) and the **Endpoint**.

With the Azure CLI instead:

```bash
az group create --name faceful --location westeurope
```

```bash
az cognitiveservices account create --name faceful-speech --resource-group faceful --kind SpeechServices --sku S0 --location westeurope --yes
```

```bash
az cognitiveservices account keys list --name faceful-speech --resource-group faceful --query key1 --output tsv
```

A resource with a custom domain (all Azure AI Foundry / AI services resources, and Speech resources given one) answers on `https://<name>.cognitiveservices.azure.com`. Use that as `AZURE_SPEECH_ENDPOINT` instead of the region; Faceful calls `<endpoint>/tts/cognitiveservices/v1`. Otherwise Faceful calls `https://<region>.tts.speech.microsoft.com/cognitiveservices/v1`.

## 2. Which value goes where

| Variable | What | Engine on Vercel | `.env.local` (local engine) | Render worker (Cloudflare secret, or `workers/reel-render/.env`) |
|---|---|---|---|---|
| `AZURE_SPEECH_KEY` | KEY 1 (secret) | yes | yes | yes |
| `AZURE_SPEECH_REGION` | e.g. `westeurope` (or set the endpoint) | yes | yes | yes |
| `AZURE_SPEECH_ENDPOINT` | e.g. `https://faceful-speech.cognitiveservices.azure.com` (instead of the region) | optional | optional | optional |
| `AZURE_TTS_VOICE` | default voice for every language | optional | optional | optional |
| `AZURE_TTS_VOICE_<LANG>` | voice for one language, e.g. `AZURE_TTS_VOICE_EL=el-GR-NestorasNeural` | optional | optional | optional |
| `CARTESIA_API_KEY`, `ELEVENLABS_API_KEY`, `FAL_KEY` | persona voice clones stored at those services | when personas have voices there | same | optional |
| `ELEVENLABS_VOICE_ID`, `CARTESIA_VOICE_ID` | extra stock voices, tried after Microsoft | optional | optional | optional |

- **Vercel**: Project → Settings → Environment Variables → add them for Production (and Preview if wanted), then redeploy.
- **`.env.local`**: the same names; `pnpm dev:api` reads them.
- **Render worker on a server**: add them to `workers/reel-render/.env`.
- **Render worker on Cloudflare**: `wrangler secret put AZURE_SPEECH_KEY` (and the others) in the worker's Cloudflare folder; see `workers/reel-render/README.md`.

Without a region or an endpoint the key is not used. Keys never appear in responses, logs or `/v1/health`.

## 3. Pick a voice

Defaults when no voice is set:

| Script language | Voice |
|---|---|
| Greek (`el`) | `el-GR-AthinaNeural` (female). Male: `el-GR-NestorasNeural` |
| English (`en`) | `en-US-AvaMultilingualNeural` |
| Anything else | `en-US-AvaMultilingualNeural`, told the script's language (`<lang xml:lang="…">`), so it reads German, French, Spanish and more natively |

Multilingual voices (names ending in `MultilingualNeural`, such as `en-US-AndrewMultilingualNeural` or `en-GB-AdaMultilingualNeural`) can read Greek too; set `AZURE_TTS_VOICE_EL` to one of them to give every language the same voice. List the voices your resource offers:

```bash
curl -sS "https://$AZURE_SPEECH_REGION.tts.speech.microsoft.com/cognitiveservices/voices/list" -H "Ocp-Apim-Subscription-Key: $AZURE_SPEECH_KEY" | jq -r '.[] | select(.Locale | startswith("el")) | "\(.ShortName)  \(.Gender)"'
```

Swap `startswith("el")` for another locale, or use `select(.ShortName | contains("Multilingual"))`. Try voices by ear in the Speech Studio voice gallery (speech.microsoft.com).

## 4. Test it with curl

```bash
curl -sS -X POST "https://$AZURE_SPEECH_REGION.tts.speech.microsoft.com/cognitiveservices/v1" -H "Ocp-Apim-Subscription-Key: $AZURE_SPEECH_KEY" -H "Content-Type: application/ssml+xml" -H "X-Microsoft-OutputFormat: audio-24khz-96kbitrate-mono-mp3" -H "User-Agent: faceful-check" --data '<speak version="1.0" xml:lang="el-GR"><voice name="el-GR-AthinaNeural">Γεια σας από το Faceful.</voice></speak>' -o faceful-tts.mp3 -w "%{http_code}\n"
```

`200` and an MP3 you can play means it works (`ffprobe faceful-tts.mp3` shows its length). With a custom domain, post to `$AZURE_SPEECH_ENDPOINT/tts/cognitiveservices/v1` instead.

| Answer | Meaning |
|---|---|
| `401` | wrong key, or a key from a resource in another region than the URL |
| `400` | the SSML is malformed, or the voice name does not exist |
| `429` | too many requests (F0 is strict); Faceful moves on to the next voice |
| `404` | the region or endpoint is wrong |

Then check the deployment: `GET /v1/health` shows `"voiceover":{"services":["azure",…]}`. Make a video with **Create** in New project and the project's files list a `… voiceover` file (voice: Microsoft …).
