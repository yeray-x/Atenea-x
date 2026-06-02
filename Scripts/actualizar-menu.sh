#!/bin/bash

set -e

rsync -e "ssh -i /home/x/.ssh/id_ed25519_auto -o IdentitiesOnly=yes" \
"yerayx@192.168.2.1:/home/yerayx/Local Sites/atenea-x/app/public/Proxmox/Scripts/ssh-menu.sh" \
/etc/profile.d/ssh-menu.sh

chmod 755 /etc/profile.d/ssh-menu.sh

ip link set ens18 down
macchanger -r ens18
ip link set ens18 up
dhclient ens18
