import { AllPublishOptions, CustomPublishOptions, GenericServerOptions, newError, PublishConfiguration } from "builder-util-runtime"
import { AppUpdater } from "./AppUpdater"
import { GenericProvider } from "./providers/GenericProvider"
import { Provider, ProviderRuntimeOptions } from "./providers/Provider"

export function isUrlProbablySupportMultiRangeRequests(url: string): boolean {
  return !url.includes("s3.amazonaws.com")
}

export function createClient(data: PublishConfiguration | AllPublishOptions, updater: AppUpdater, runtimeOptions: ProviderRuntimeOptions): Provider<any> {
  // noinspection SuspiciousTypeOfGuard
  if (typeof data === "string") {
    throw newError("Please pass PublishConfiguration object", "ERR_UPDATER_INVALID_PROVIDER_CONFIGURATION")
  }

  const provider = data.provider
  switch (provider) {
    case "generic": {
      const options = data as GenericServerOptions
      return new GenericProvider(options, updater, {
        ...runtimeOptions,
        isUseMultipleRangeRequest: options.useMultipleRangeRequest !== false && isUrlProbablySupportMultiRangeRequests(options.url),
      })
    }

    case "custom": {
      const options = data as CustomPublishOptions
      const constructor = options.updateProvider
      if (!constructor) {
        throw newError("Custom provider not specified", "ERR_UPDATER_INVALID_PROVIDER_CONFIGURATION")
      }
      return new constructor(options, updater, runtimeOptions)
    }

    default:
      throw newError(`Unsupported provider: ${provider}`, "ERR_UPDATER_UNSUPPORTED_PROVIDER")
  }
}
