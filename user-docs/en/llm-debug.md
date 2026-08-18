User is installing pican via the [install.sh](https://raw.githubusercontent.com/Yeshwanthyk/pican/refs/heads/main/install.sh)
script, which downloads the pican binary from GitHub Releases and sets up auto-start.

```bash
curl -fsSL https://raw.githubusercontent.com/Yeshwanthyk/pican/main/install.sh | bash
```

If user is having issue it might be the setup of install.sh is causing issue. You can review and check what's going on and provide user what exactly is causing problem. And ask if they want you to fix. Always confirm with user.

In order for user to be able to access the pi in their mobile or other network. The recommended way is to use tailscale and access it form tailscale network. And user will have to enable the HTTPs in their tailscale dashboard - https://login.tailscale.com/admin/dns

If they don't have tailscale install or don't want to use tailscale. They can run `pican status` and get the binary path, status of the binary and the local endpoint which they can access the application. But to note, they won't be able to get the push notification as it's in http.

In mac it's setup [com.pican.plist](https://raw.githubusercontent.com/Yeshwanthyk/pican/refs/heads/main/init/com.pican.plist)
In linux it setup [pican.service](https://github.com/Yeshwanthyk/pican/blob/main/init/pican.service)

In case if you need to debug futher and see what's going on.
