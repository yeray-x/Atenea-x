#!/bin/bash

SUDO=""
if [ "$EUID" -ne 0 ]; then
    SUDO="sudo"
fi

# Detectar si venimos de SSH o login interactivo
if [ -z "$SSH_CONNECTION" ]; then
    return 0 2>/dev/null || true
fi

clear
echo "======================================="
echo " CONFIGURACIÓN INICIAL DEL EQUIPO"
echo "======================================="
echo ""

read -p "¿Quieres hacer algún cambio en el equipo? (s/n): " respuesta

if [[ "$respuesta" != "s" && "$respuesta" != "S" ]]; then
    $SUDO macchanger -r ens18
    echo "No se realizarán cambios."
    break 0
fi

while true; do
    echo ""
    echo "Selecciona una opción:"
    echo "1 - Cambiar nombre del equipo"
    echo "2 - Configurar IP estática"
    echo "3 - Añadir nuevo usuario"
    echo "4 - Cambiar zona horaria"
    echo "5 - Instalar paquetes básicos"
    echo "6 - Actualizar sistema"
    echo "7 - Salir"
    echo "8 - Docker"
    echo "9 -Reiniciar"
    echo ""

    read -p "Opción: " opcion

    case $opcion in

        1)
            read -p "Nuevo nombre del equipo: " nuevo_hostname

            $SUDO hostnamectl set-hostname "$nuevo_hostname"
            $SUDO sed -i "s/^127.0.1.1.*/127.0.1.1 $nuevo_hostname/" /etc/hosts

            echo "Nombre cambiado correctamente."
            ;;

        2)
            echo ""
            echo "Interfaces disponibles:"
            ip -br link | awk '{print " - " $1}'
            echo ""

            read -p "Nombre de la interfaz (ej: ens18): " interfaz
            read -p "IP estática (ej: 192.168.2.100/24): " ip_estatica

            gateway="192.168.2.1"
            dns="192.168.2.1"

            echo ""
            echo "Gateway configurado automáticamente: $gateway"
            echo "DNS configurado automáticamente: $dns"
            echo ""

            $SUDO cat > /etc/netplan/01-config.yaml <<EOF
network:
  version: 2
  renderer: networkd
  ethernets:
    $interfaz:
      dhcp4: no
      addresses:
        - $ip_estatica
      routes:
        - to: default
          via: $gateway
      nameservers:
        addresses:
          - $dns
EOF

            $SUDO netplan apply
            echo "IP configurada correctamente."
            ;;

        3)
            read -p "Nombre del nuevo usuario: " usuario

            if id "$usuario" &>/dev/null; then
                echo "Ese usuario ya existe."
            else
                $SUDO adduser "$usuario"

                read -p "¿Quieres hacerlo administrador? (s/n): " admin

                if [[ "$admin" == "s" || "$admin" == "S" ]]; then
                    $SUDO usermod -aG sudo "$usuario"
                    echo "Usuario creado y añadido al grupo sudo (administrador)."
                else
                    echo "Usuario creado."
                fi
            fi
            ;;

        4)
            echo ""
            echo "Ejemplos:"
            echo "  Europe/Madrid"
            echo "  UTC"
            echo "  America/New_York"
            echo ""

            read -p "Nueva zona horaria: " zona

            $SUDO timedatectl set-timezone "$zona"
            echo "Zona horaria actualizada."
            ;;

        5)
            $SUDO apt update
            $SUDO apt install -y curl wget net-tools htop vim git
            echo "Paquetes instalados."
            ;;

        6)
            $SUDO apt update && $SUDO apt upgrade -y
            echo "Sistema actualizado."
            ;;

        7)
            $SUDO macchanger -r ens18 &>/dev/null
            echo "Saliendo..."

            USERNAME="x"

            if id "$USERNAME" &>/dev/null; then

                if pgrep -u "$USERNAME" &>/dev/null; then
                    echo "El usuario $USERNAME sigue en uso. Por favor, crea un usuario y reinicia el ordenador. No siga utilizando el usuario por defecto"
                    break 0
                fi

                echo "Borrando usuario $USERNAME..."

                $SUDO userdel -r "$USERNAME" &>/dev/null

                echo "Usuario eliminado correctamente."
            fi

            break 0
            ;;

        8)

            if ! command -v docker &> /dev/null; then
                echo "Docker no encontrado. Instalando..."

                $SUDO apt update
                $SUDO apt install -y ca-certificates curl gnupg

                $SUDO install -m 0755 -d /etc/apt/keyrings

                curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
                gpg --dearmor | $SUDO tee /etc/apt/keyrings/docker.gpg > /dev/null

                echo \
                "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
                $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
                $SUDO tee /etc/apt/sources.list.d/docker.list > /dev/null

                $SUDO apt update

                $SUDO apt install -y \
                docker-ce \
                docker-ce-cli \
                containerd.io \
                docker-buildx-plugin \
                docker-compose-plugin

                $SUDO systemctl enable docker
                $SUDO systemctl start docker

                echo "Docker instalado correctamente."
            fi

            clear
            echo "===================================="
            echo "   PANEL DOCKER SSH"
            echo "===================================="
            echo ""

            echo "¿Qué máquina Docker quieres desplegar?"
            echo ""
            echo "1) Minecraft Server (Java)"
            echo "2) Terraria Server"
            echo "3) CS2 Server (básico / SteamCMD)"
            echo "4) Buscar imagen en Docker Hub"
            echo "5) Ver contenedores activos"
            echo "6) Volver"
            echo ""

            read -p "Opción: " docker_opcion

            case $docker_opcion in

                1)
                    echo "Desplegando Minecraft Server..."

                    $SUDO docker run -d \
                        --name minecraft \
                        -p 25565:25565 \
                        -e EULA=TRUE \
                        itzg/minecraft-server
                    ;;

                2)
                    echo "Desplegando Terraria Server..."

                    $SUDO docker run -d \
                        --name terraria \
                        -p 7777:7777 \
                        ich777/terraria
                    ;;

                3)
                    echo "CS2 requiere configuración avanzada (SteamCMD)."

                    $SUDO docker run -it \
                        --name cs2 \
                        cm2network/cs2
                    ;;

                4)
                    read -p "Nombre de la imagen a buscar: " img

                    echo "Buscando en Docker Hub..."
                    $SUDO docker search "$img"

                    read -p "Nombre exacto de imagen para ejecutar: " runimg

                    $SUDO docker run -d "$runimg"
                    ;;

                5)
                    $SUDO docker ps -a
                    ;;

                6)
                    echo "Volviendo..."
                    ;;

                *)
                    echo "Opción inválida"
                    ;;

            esac
            ;;

        *)
            echo "Opción inválida."
            ;;
        9)
            $SUDO reboot
            ;;
    esac
done
