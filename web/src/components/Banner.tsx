import type { ReactNode } from "react"
import { Alert } from "@heroui/react"

export type BannerStatus = "default" | "accent" | "success" | "warning" | "danger"

export function Banner({ status = "danger", title, children }: { status?: BannerStatus; title: string; children?: ReactNode }) {
  return (
    <Alert status={status}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{title}</Alert.Title>
        {children ? <Alert.Description>{children}</Alert.Description> : null}
      </Alert.Content>
    </Alert>
  )
}
