import type { ReactNode } from "react"
import { Button, Modal } from "@heroui/react"

/** A modal that unmounts its body when closed, so typed secrets do not linger in the DOM. */
export function Dialog({ open, title, onClose, children, footer }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return (
    <Modal>
      <Modal.Backdrop isOpen={open} onOpenChange={(o) => !o && onClose()}>
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-[480px]">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>{title}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>{open ? children : null}</Modal.Body>
            {footer ? <Modal.Footer>{footer}</Modal.Footer> : null}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

export function Confirm({ open, title, body, confirmLabel, danger, busy, onClose, onConfirm }: {
  open: boolean
  title: string
  body: ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} isPending={busy} onPress={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p>{body}</p>
    </Dialog>
  )
}
