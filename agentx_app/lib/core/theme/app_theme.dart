import 'package:flutter/material.dart';

/// AgentX Dark Glassmorphism Theme
class AppTheme {
  // Colors
  static const Color background = Color(0xFF08070C);
  static const Color surface = Color(0xFF12101A);
  static const Color glass = Color(0x08FFFFFF); // rgba(255,255,255,0.03)
  static const Color glassBorder = Color(0x0AFFFFFF); // rgba(255,255,255,0.04)
  static const Color purpleStart = Color(0xFF7C3AED);
  static const Color purpleEnd = Color(0xFF9333EA);
  static const Color pink = Color(0xFFEC4899);
  static const Color green = Color(0xFF34D399);
  static const Color red = Color(0xFFF87171);
  static const Color textPrimary = Color(0xFFFFFFFF);
  static const Color textSecondary = Color(0xFFBBBBCC);
  static const Color textMuted = Color(0xFF71717A);
  static const Color textDim = Color(0xFF52525B);

  static const purpleGradient = LinearGradient(
    colors: [purpleStart, purpleEnd, pink],
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
  );

  static const purpleGradientSimple = LinearGradient(
    colors: [purpleStart, purpleEnd],
  );

  static ThemeData get darkTheme => ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: background,
        colorScheme: const ColorScheme.dark(
          surface: surface,
          primary: purpleStart,
          secondary: purpleEnd,
          error: red,
        ),
        fontFamily: 'Inter',
        appBarTheme: const AppBarTheme(
          backgroundColor: Colors.transparent,
          elevation: 0,
        ),
        bottomNavigationBarTheme: const BottomNavigationBarThemeData(
          backgroundColor: Colors.transparent,
        ),
      );
}
