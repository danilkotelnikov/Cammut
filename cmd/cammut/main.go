// Command cammut is the Cammut gateway daemon and its admin CLI.
package main

import (
	"fmt"
	"os"
)

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "cammut:", err)
		os.Exit(1)
	}
}
