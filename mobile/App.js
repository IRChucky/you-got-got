import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import { io } from "socket.io-client";

export default function App() {
  useEffect(() => {
    const socket = io("http://10.24.37.196:3000", {
      transports: ["websocket"],
    });

    socket.on("connect", () => {
      console.log("Connected to server:", socket.id);
    });

    socket.on("connect_error", (err) => {
      console.log("Connection error:", err.message);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>You Got Got</Text>
      <Text style={styles.subtitle}>Fresh setup running</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#12131A",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  title: {
    color: "white",
    fontSize: 32,
    fontWeight: "bold",
    marginBottom: 12,
  },
  subtitle: {
    color: "#B8BCC6",
    fontSize: 18,
  },
});
