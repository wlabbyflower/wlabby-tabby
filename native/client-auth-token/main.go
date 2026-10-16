// Retrieve a device-scoped token using the application's SDK certificate.
// The token is returned only to the parent backend process, never to a browser.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	lzcsdk "gitee.com/linakesi/lzc-sdk/lang/go"
	"net/url"
	"os"
	"time"
)

func run() error {
	if len(os.Args) != 2 {
		return fmt.Errorf("device API URL required")
	}
	target, err := url.Parse(os.Args[1])
	if err != nil || (target.Scheme != "https" && target.Scheme != "http") || target.Host == "" || target.User != nil {
		return fmt.Errorf("invalid device API URL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	gateway, err := lzcsdk.NewAPIGateway(ctx)
	if err != nil {
		return fmt.Errorf("application SDK authorization unavailable")
	}
	defer gateway.Close()
	device, err := gateway.NewDeviceProxy(target.String())
	if err != nil {
		return fmt.Errorf("device proxy unavailable")
	}
	defer device.Close()
	token, err := device.GetAuthToken(ctx)
	if err != nil || token == nil || token.Token == "" {
		return fmt.Errorf("device authorization unavailable")
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]string{"token": token.Token})
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
