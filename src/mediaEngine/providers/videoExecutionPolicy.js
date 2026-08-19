import { MediaJobError } from '../jobs/errors.js'
import { resolveVideoRunnerMode } from '../jobs/videoLeaseBootstrap.js'
import { VIDEO_RENDER_OPERATION } from './composerVideo.js'

export function assertDefaultVideoExecutionAvailable({ env = process.env, input } = {}) {
  if (env.MEDIA_JOB_STORE === 'postgres' && resolveVideoRunnerMode(env) === 'disabled' && input?.operation === VIDEO_RENDER_OPERATION) {
    throw new MediaJobError(
      'VIDEO_DURABLE_RUNNER_REQUIRED',
      'video.render requires a durable shared runner when MEDIA_JOB_STORE=postgres',
      { status: 503 },
    )
  }
}
