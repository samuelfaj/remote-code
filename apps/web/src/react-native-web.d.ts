declare module "react-native-web" {
  import type { ComponentType, ReactNode } from "react";

  type NativeStyle = Record<string, string | number | undefined>;
  type StyleValue = NativeStyle | false | null | undefined;
  type StyleList = StyleValue[];
  type BaseProps = {
    children?: ReactNode;
    style?: StyleValue | StyleList;
    testID?: string;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    "aria-live"?: "polite" | "assertive" | "off";
  };
  type PressableProps = Omit<BaseProps, "style"> & {
    accessibilityState?: { disabled?: boolean };
    disabled?: boolean;
    onPress?: () => void;
    style?: StyleValue | StyleList | ((state: { pressed: boolean }) => StyleValue | StyleList);
  };

  export const View: ComponentType<BaseProps>;
  export const ScrollView: ComponentType<BaseProps & { contentContainerStyle?: StyleValue | StyleList }>;
  export const Text: ComponentType<BaseProps & { selectable?: boolean }>;
  export const TextInput: ComponentType<BaseProps & {
    onChangeText?: (value: string) => void;
    placeholder?: string;
    value?: string;
  }>;
  export const Pressable: ComponentType<PressableProps>;
  export const StyleSheet: {
    create<T extends Record<string, NativeStyle>>(styles: T): T;
  };
}
